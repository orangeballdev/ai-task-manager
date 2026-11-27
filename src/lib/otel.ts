/**
 * OpenTelemetry runtime — owns the exporters for one process.
 *
 * Each process (Next app, worker, integrations) calls `initTelemetry()` once.
 * It reads the `otel_*` settings (see src/lib/otel-config.ts), polls them, and
 * whenever their fingerprint changes it tears down the current providers and
 * builds new ones — so the Settings → Observability toggle and endpoint edits
 * take effect live, without a restart.
 *
 * Hot swapping is why nothing here hands out long-lived SDK objects:
 *   - Traces: a *delegating* TracerProvider is registered globally once and
 *     forwards every call to whatever provider is current (or a no-op). Next.js's
 *     built-in request spans and our own `getTracer()` spans both go through it.
 *   - Metrics: `getMeter()` returns the current meter; callers look instruments
 *     up per use. Observable instruments are re-registered on each (re)start via
 *     `onMeterReady()`.
 *   - Logs: `emitLog()` writes to the current logger, if any.
 * The trade-off: a span that started before a config change and ends after it
 * is dropped, because its provider has been shut down.
 *
 * Several destinations are supported by giving each provider one span
 * processor / metric reader / log processor per destination, each with its own
 * exporter and batch queue — so a slow or dead backend can't hold up the others.
 *
 * Exporter failures are rate-limited to one console line a minute (per
 * destination) and written with the original (uncaptured) console, so a dead
 * collector can neither spam the logs nor feed its own error messages back into
 * the log exporter.
 */
import os from "os";
import { format } from "util";
import {
  ROOT_CONTEXT,
  TraceFlags,
  context,
  diag,
  DiagLogLevel,
  createNoopMeter,
  ProxyTracerProvider,
  trace,
  type Attributes,
  type Meter,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import { SeverityNumber, type AnyValueMap } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SamplingDecision,
  SimpleSpanProcessor,
  type Sampler,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import {
  MeterProvider,
  MetricReader,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter as ProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter as ProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter as JsonMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter as JsonLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPLogExporter as GrpcLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { Metadata } from "@grpc/grpc-js";
import {
  IGNORED_PRISMA_SPANS,
  OTEL_SIGNALS,
  destinationLabel,
  exportTargets,
  isOtelActive,
  otelConfigFingerprint,
  parseOtelSettings,
  serviceNameFor,
  shouldRecordSpan,
  signalUrl,
  type OtelConfig,
  type OtelDestination,
  type OtelRole,
  type OtelSignal,
} from "./otel-config";

const SCOPE = "claude-task-manager";
const DEFAULT_POLL_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXPORT_TIMEOUT_MS = 10_000;

interface Providers {
  tracer?: BasicTracerProvider;
  meter?: MeterProvider;
  logger?: LoggerProvider;
}

interface TelemetryState {
  role: OtelRole;
  config: OtelConfig;
  fingerprint: string;
  providers: Providers;
  loadSettings: () => Promise<Record<string, string>>;
  applying: Promise<void>;
  meterReadyCallbacks: ((meter: Meter) => void)[];
}

// Kept on globalThis so Next's dev-mode module reloads don't double-initialise.
const globalForOtel = globalThis as unknown as { __ctmOtel?: TelemetryState };

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

/** A console.warn that prints at most once a minute, counting what it swallowed. */
function rateLimitedWarn(): (message: string, ...args: unknown[]) => void {
  let lastAt = 0;
  let suppressed = 0;
  return (message, ...args) => {
    const now = Date.now();
    if (now - lastAt < 60_000) { suppressed++; return; }
    const note = suppressed > 0 ? ` (${suppressed} similar message(s) suppressed)` : "";
    lastAt = now;
    suppressed = 0;
    originalConsole.warn(`[otel] ${message}${note}`, ...args);
  };
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

function grpcMetadata(headers: Record<string, string>): Metadata {
  const metadata = new Metadata();
  for (const [key, value] of Object.entries(headers)) metadata.set(key.toLowerCase(), value);
  return metadata;
}

function createSpanExporter(dest: OtelDestination): SpanExporter {
  const url = signalUrl(dest, "traces");
  if (dest.protocol === "grpc") {
    return new GrpcTraceExporter({ url, metadata: grpcMetadata(dest.headers), timeoutMillis: EXPORT_TIMEOUT_MS });
  }
  const options = { url, headers: dest.headers, timeoutMillis: EXPORT_TIMEOUT_MS };
  return dest.protocol === "http/json" ? new JsonTraceExporter(options) : new ProtoTraceExporter(options);
}

function createMetricExporter(dest: OtelDestination): PushMetricExporter {
  const url = signalUrl(dest, "metrics");
  if (dest.protocol === "grpc") {
    return new GrpcMetricExporter({ url, metadata: grpcMetadata(dest.headers), timeoutMillis: EXPORT_TIMEOUT_MS });
  }
  const options = { url, headers: dest.headers, timeoutMillis: EXPORT_TIMEOUT_MS };
  return dest.protocol === "http/json" ? new JsonMetricExporter(options) : new ProtoMetricExporter(options);
}

function createLogExporter(dest: OtelDestination): LogRecordExporter {
  const url = signalUrl(dest, "logs");
  if (dest.protocol === "grpc") {
    return new GrpcLogExporter({ url, metadata: grpcMetadata(dest.headers), timeoutMillis: EXPORT_TIMEOUT_MS });
  }
  const options = { url, headers: dest.headers, timeoutMillis: EXPORT_TIMEOUT_MS };
  return dest.protocol === "http/json" ? new JsonLogExporter(options) : new ProtoLogExporter(options);
}

type ExportCallback = (result: { code: number; error?: Error }) => void;

/**
 * Wraps an exporter so a failed export is reported with the destination's name
 * — with two backends configured, "which one is failing" is the first question,
 * and the SDK's own diagnostics don't say. Everything else passes through.
 */
function reportFailures<T extends { export(items: never, cb: ExportCallback): void }>(
  exporter: T,
  dest: OtelDestination,
  signal: OtelSignal,
): T {
  const warn = rateLimitedWarn();
  return new Proxy(exporter, {
    get(target, prop) {
      if (prop === "export") {
        return (items: never, cb: ExportCallback) =>
          target.export(items, (result) => {
            // ExportResultCode.SUCCESS === 0
            if (result.code !== 0) {
              warn(`Exporting ${signal} to ${destinationLabel(dest)} failed: ${result.error?.message || "unknown error"}`);
            }
            cb(result);
          });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Builds one pipeline component per destination taking `signal`. A destination
 * whose exporter can't be constructed (e.g. a malformed URL) is skipped and
 * logged, so it can't take the working ones down with it.
 */
function perDestination<T>(config: OtelConfig, signal: OtelSignal, build: (dest: OtelDestination) => T): T[] {
  const out: T[] = [];
  for (const dest of exportTargets(config, signal)) {
    try {
      out.push(build(dest));
    } catch (err) {
      originalConsole.error(`[otel] Can't export ${signal} to ${destinationLabel(dest)}:`, err);
    }
  }
  return out;
}

function buildResource(config: OtelConfig, role: OtelRole): Resource {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceNameFor(config, role),
    "service.namespace": config.serviceName,
    "service.instance.id": `${os.hostname()}-${process.pid}`,
    "host.name": os.hostname(),
    "process.pid": process.pid,
    "ctm.process.role": role,
    ...config.resourceAttributes,
  });
}

/** See shouldRecordSpan(): drops root-level DB spans (background polling) and follows the parent otherwise. */
const sampler: Sampler = {
  shouldSample(ctx, _traceId, spanName) {
    const parent = trace.getSpanContext(ctx);
    const record = shouldRecordSpan(spanName, parent ? { sampled: (parent.traceFlags & TraceFlags.SAMPLED) !== 0 } : undefined);
    return { decision: record ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD };
  },
  toString: () => "CtmSampler",
};

// Prisma's client looks this up on every query, so enabling/disabling it on a
// reload switches query tracing live (see syncPrismaInstrumentation).
let prismaInstrumentation: PrismaInstrumentation | null = null;

function syncPrismaInstrumentation(config: OtelConfig): void {
  const want = exportTargets(config, "traces").length > 0 && config.dbSpans;
  if (want && !prismaInstrumentation) {
    prismaInstrumentation = new PrismaInstrumentation({ ignoreSpanTypes: IGNORED_PRISMA_SPANS });
    prismaInstrumentation.enable();
  } else if (!want && prismaInstrumentation) {
    prismaInstrumentation.disable();
    prismaInstrumentation = null;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function startProviders(config: OtelConfig, role: OtelRole, meterReady: ((meter: Meter) => void)[]): Providers {
  const resource = buildResource(config, role);
  const providers: Providers = {};
  const spanProcessors: SpanProcessor[] = perDestination(config, "traces", (dest) =>
    new BatchSpanProcessor(reportFailures(createSpanExporter(dest), dest, "traces")));
  if (spanProcessors.length > 0) {
    providers.tracer = new BasicTracerProvider({ resource, sampler, spanProcessors });
  }
  const readers: MetricReader[] = perDestination(config, "metrics", (dest) =>
    new PeriodicExportingMetricReader({
      exporter: reportFailures(createMetricExporter(dest), dest, "metrics"),
      exportIntervalMillis: config.metricIntervalMs,
      exportTimeoutMillis: Math.min(EXPORT_TIMEOUT_MS, config.metricIntervalMs),
    }));
  if (readers.length > 0) {
    providers.meter = new MeterProvider({ resource, readers });
    const meter = providers.meter.getMeter(SCOPE);
    for (const cb of meterReady) {
      try { cb(meter); } catch (err) { originalConsole.error("[otel] meter callback failed:", err); }
    }
  }
  const logProcessors: LogRecordProcessor[] = perDestination(config, "logs", (dest) =>
    new BatchLogRecordProcessor({ exporter: reportFailures(createLogExporter(dest), dest, "logs") }));
  if (logProcessors.length > 0) {
    providers.logger = new LoggerProvider({ resource, processors: logProcessors });
  }
  return providers;
}

async function stopProviders(providers: Providers): Promise<void> {
  const shutdowns = [providers.tracer?.shutdown(), providers.meter?.shutdown(), providers.logger?.shutdown()]
    .filter(Boolean)
    .map((p) => (p as Promise<void>).catch(() => {}));
  await Promise.race([
    Promise.all(shutdowns),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
  ]);
}

async function apply(state: TelemetryState, config: OtelConfig): Promise<void> {
  const fingerprint = otelConfigFingerprint(config);
  // forwardToAgent is read per spawn, so always keep the latest config.
  state.config = config;
  syncPrismaInstrumentation(config);
  if (fingerprint === state.fingerprint) return;

  const previous = state.providers;
  state.providers = {};
  state.fingerprint = fingerprint;
  await stopProviders(previous);

  if (isOtelActive(config)) {
    try {
      state.providers = startProviders(config, state.role, state.meterReadyCallbacks);
      originalConsole.log(`[otel] Exporting as ${serviceNameFor(config, state.role)}`);
      for (const dest of config.destinations) {
        const signals = OTEL_SIGNALS.filter((s) => exportTargets(config, s).includes(dest));
        if (signals.length === 0) continue;
        originalConsole.log(`[otel]   → ${destinationLabel(dest)}: ${signals.join(", ")} to ${dest.endpoint} (${dest.protocol})`);
      }
    } catch (err) {
      state.providers = {};
      originalConsole.error("[otel] Failed to start exporters:", err);
    }
  } else if (previous.tracer || previous.meter || previous.logger) {
    originalConsole.log("[otel] Export disabled");
  }
}

async function reload(state: TelemetryState): Promise<void> {
  let settings: Record<string, string>;
  try {
    settings = await state.loadSettings();
  } catch (err) {
    originalConsole.error("[otel] Failed to read settings:", err);
    return;
  }
  const config = parseOtelSettings(settings);
  // Serialise applies: a slow shutdown must finish before the next start.
  state.applying = state.applying.then(() => apply(state, config));
  await state.applying;
}

// ---------------------------------------------------------------------------
// Globals registered once per process
// ---------------------------------------------------------------------------

const noopTracerProvider = new ProxyTracerProvider();

function currentTracerProvider(): TracerProvider {
  return globalForOtel.__ctmOtel?.providers.tracer ?? noopTracerProvider;
}

/** Forwards to whichever provider is current, so a globally registered tracer survives reloads. */
class DelegatingTracerProvider implements TracerProvider {
  getTracer(name: string, version?: string, options?: { schemaUrl?: string }): Tracer {
    const current = () => currentTracerProvider().getTracer(name, version, options);
    return {
      startSpan: (...args: Parameters<Tracer["startSpan"]>) => current().startSpan(...args),
      startActiveSpan: ((...args: unknown[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (current().startActiveSpan as any)(...args)) as Tracer["startActiveSpan"],
    };
  }
}

function createRateLimitedDiagLogger() {
  const report = rateLimitedWarn();
  const ignore = () => {};
  return { error: report, warn: report, info: ignore, debug: ignore, verbose: ignore };
}

const CONSOLE_SEVERITY: Record<keyof typeof originalConsole, [SeverityNumber, string]> = {
  debug: [SeverityNumber.DEBUG, "DEBUG"],
  log: [SeverityNumber.INFO, "INFO"],
  info: [SeverityNumber.INFO, "INFO"],
  warn: [SeverityNumber.WARN, "WARN"],
  error: [SeverityNumber.ERROR, "ERROR"],
};

let inConsoleCapture = false;

function patchConsole(): void {
  for (const method of Object.keys(originalConsole) as (keyof typeof originalConsole)[]) {
    console[method] = (...args: unknown[]) => {
      originalConsole[method](...args);
      const state = globalForOtel.__ctmOtel;
      if (inConsoleCapture || !state?.providers.logger || !state.config.captureConsole) return;
      inConsoleCapture = true;
      try {
        const [severityNumber, severityText] = CONSOLE_SEVERITY[method];
        state.providers.logger.getLogger(SCOPE).emit({
          severityNumber,
          severityText,
          body: format(...args),
          attributes: { "ctm.log.source": "console" },
        });
      } catch {
        /* never let telemetry break logging */
      } finally {
        inConsoleCapture = false;
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitTelemetryOptions {
  role: OtelRole;
  /** Returns every Setting row as key → value. */
  loadSettings: () => Promise<Record<string, string>>;
  pollIntervalMs?: number;
}

/** Starts telemetry for this process and keeps it in sync with the settings. Idempotent. */
export async function initTelemetry(options: InitTelemetryOptions): Promise<void> {
  if (globalForOtel.__ctmOtel) return;
  const state: TelemetryState = {
    role: options.role,
    config: parseOtelSettings({}),
    fingerprint: "off",
    providers: {},
    loadSettings: options.loadSettings,
    applying: Promise.resolve(),
    meterReadyCallbacks: [],
  };
  globalForOtel.__ctmOtel = state;

  diag.setLogger(createRateLimitedDiagLogger(), DiagLogLevel.WARN);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new DelegatingTracerProvider());
  patchConsole();

  await reload(state);
  setInterval(() => { void reload(state); }, options.pollIntervalMs ?? DEFAULT_POLL_MS).unref();
}

/** Re-reads the settings now instead of waiting for the next poll. */
export async function reloadTelemetry(): Promise<void> {
  const state = globalForOtel.__ctmOtel;
  if (state) await reload(state);
}

/** Flushes and stops exporting (e.g. before a deliberate process exit). */
export async function shutdownTelemetry(): Promise<void> {
  const state = globalForOtel.__ctmOtel;
  if (!state) return;
  const providers = state.providers;
  state.providers = {};
  state.fingerprint = "off";
  await stopProviders(providers);
}

/**
 * Runs `fn` outside any trace. For long-lived background loops inside a request
 * (the live-log SSE stream) whose polling queries would otherwise pile up
 * under that request's span; detached, they count as background work and the
 * sampler drops them.
 */
export function detachFromTrace<T>(fn: () => T): T {
  return context.with(ROOT_CONTEXT, fn);
}

export function getTracer(): Tracer {
  return trace.getTracer(SCOPE);
}

const noopMeter = createNoopMeter();

/** The current meter (a no-op when metrics are off). Look instruments up per use — they don't survive a reload. */
export function getMeter(): Meter {
  return globalForOtel.__ctmOtel?.providers.meter?.getMeter(SCOPE) ?? noopMeter;
}

/** Registers observable instruments; runs now if metrics are on, and again after every reload. */
export function onMeterReady(callback: (meter: Meter) => void): void {
  const state = globalForOtel.__ctmOtel;
  if (!state) return;
  state.meterReadyCallbacks.push(callback);
  const meter = state.providers.meter?.getMeter(SCOPE);
  if (meter) callback(meter);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_SEVERITY: Record<LogLevel, [SeverityNumber, string]> = {
  debug: [SeverityNumber.DEBUG, "DEBUG"],
  info: [SeverityNumber.INFO, "INFO"],
  warn: [SeverityNumber.WARN, "WARN"],
  error: [SeverityNumber.ERROR, "ERROR"],
};

/**
 * Emits one log record, correlated with `span` when given (otherwise the active span).
 * `eventName` makes it an OTel *event* (e.g. `gen_ai.evaluation.result`).
 */
export function emitLog(body: string, level: LogLevel, attributes: AnyValueMap = {}, span?: Span, eventName?: string): void {
  const logger = globalForOtel.__ctmOtel?.providers.logger;
  if (!logger) return;
  const [severityNumber, severityText] = LEVEL_SEVERITY[level];
  try {
    logger.getLogger(SCOPE).emit({
      severityNumber,
      severityText,
      body,
      ...(eventName ? { eventName } : {}),
      attributes: eventName ? { "event.name": eventName, ...attributes } : attributes,
      ...(span ? { context: trace.setSpan(context.active(), span) } : {}),
    });
  } catch {
    /* never let telemetry break the caller */
  }
}

/** True when this process is currently exporting anything. */
export function isTelemetryActive(): boolean {
  const providers = globalForOtel.__ctmOtel?.providers;
  return !!(providers?.tracer || providers?.meter || providers?.logger);
}

// ---------------------------------------------------------------------------
// Connection test (Settings → Observability → "Send test data")
// ---------------------------------------------------------------------------

export interface SignalTestResult {
  signal: OtelSignal;
  ok: boolean;
  url: string;
  error?: string;
}

/** Collects on demand, so the test can export exactly one batch and see the result. */
class OneShotMetricReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

function exportOnce<T>(exporter: { export(items: T, cb: (r: { code: number; error?: Error }) => void): void; shutdown(): Promise<void> }, items: T): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("Timed out waiting for the collector"), EXPORT_TIMEOUT_MS + 2_000);
    exporter.export(items, (result) => {
      clearTimeout(timer);
      // ExportResultCode.SUCCESS === 0
      resolve(result.code === 0 ? undefined : (result.error?.message || "Export failed"));
    });
  }).finally(() => { void exporter.shutdown().catch(() => {}); }) as Promise<string | undefined>;
}

/**
 * Sends one test span, metric and log record (for each signal the destination
 * takes) to `dest`, independent of whether export or the destination is
 * switched on, and reports what the collector said. `config` supplies the
 * shared resource (service name, attributes).
 */
export async function testOtelExport(config: OtelConfig, dest: OtelDestination, role: OtelRole = "app"): Promise<SignalTestResult[]> {
  const resource = buildResource(config, role);
  const results: SignalTestResult[] = [];
  const attrs: Attributes = { "ctm.test": true };

  const run = async (signal: SignalTestResult["signal"], send: () => Promise<string | undefined>) => {
    const url = signalUrl(dest, signal);
    try {
      const error = await send();
      results.push({ signal, ok: !error, url, ...(error ? { error } : {}) });
    } catch (err) {
      results.push({ signal, ok: false, url, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const tasks: Promise<void>[] = [];
  if (dest.traces) {
    tasks.push(run("traces", async () => {
      const memory = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor(memory)] });
      provider.getTracer(SCOPE).startSpan("otel.test", { attributes: attrs }).end();
      await provider.forceFlush();
      return exportOnce(createSpanExporter(dest), memory.getFinishedSpans());
    }));
  }
  if (dest.metrics) {
    tasks.push(run("metrics", async () => {
      const reader = new OneShotMetricReader();
      const provider = new MeterProvider({ resource, readers: [reader] });
      provider.getMeter(SCOPE).createCounter("ctm.otel.test").add(1, attrs);
      const { resourceMetrics } = await reader.collect();
      return exportOnce(createMetricExporter(dest), resourceMetrics);
    }));
  }
  if (dest.logs) {
    tasks.push(run("logs", async () => {
      const memory = new InMemoryLogRecordExporter();
      const provider = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter: memory })] });
      provider.getLogger(SCOPE).emit({
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        body: "OpenTelemetry test log from Claude Task Manager",
        attributes: attrs,
      });
      await provider.forceFlush();
      return exportOnce(createLogExporter(dest), memory.getFinishedLogRecords());
    }));
  }
  await Promise.all(tasks);
  const order = ["traces", "metrics", "logs"];
  return results.sort((a, b) => order.indexOf(a.signal) - order.indexOf(b.signal));
}
