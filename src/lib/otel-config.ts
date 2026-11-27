/**
 * OpenTelemetry export settings — the pure half (no SDK imports, unit-tested).
 *
 * Everything lives in `Setting` rows so it can be edited from Settings →
 * Observability. Each process (app, worker, integrations) reads the rows via
 * `parseOtelSettings()` and hands the result to `src/lib/otel.ts`, which
 * re-reads them periodically and restarts its exporters when
 * `otelConfigFingerprint()` changes — so toggling export on/off or pointing it
 * at a new collector takes effect without restarting anything.
 *
 * Telemetry can be fanned out to several *destinations* (e.g. a self-hosted
 * collector and a SaaS backend at once). Each destination has its own
 * endpoint, protocol, headers and per-signal toggles, and they are stored
 * together as JSON in `otel_destinations`. Everything else — the master
 * switch, which signals are produced at all, service name, resource
 * attributes — is shared. A signal reaches a destination only when it is on
 * both globally and for that destination (`exportTargets()`).
 */

export const OTEL_SETTING_KEYS = {
  enabled: "otel_enabled",
  destinations: "otel_destinations",
  serviceName: "otel_service_name",
  resourceAttributes: "otel_resource_attributes",
  tracesEnabled: "otel_traces_enabled",
  metricsEnabled: "otel_metrics_enabled",
  logsEnabled: "otel_logs_enabled",
  dbSpans: "otel_db_spans",
  /** Record what each agent tool call was asked to do (redacted) on its execute_tool span. */
  toolArguments: "otel_tool_arguments",
  captureConsole: "otel_capture_console",
  forwardToAgent: "otel_forward_to_agent",
  /** Destination id the Claude CLI forwards to — it can only export to one endpoint. */
  agentDestination: "otel_agent_destination",
  metricIntervalSeconds: "otel_metric_interval_seconds",
} as const;

/**
 * The single-collector keys from before destinations existed. Read only while
 * `otel_destinations` has never been saved (they become the first
 * destination), and deleted on the first save of the list.
 */
export const LEGACY_OTEL_DESTINATION_KEYS = {
  endpoint: "otel_endpoint",
  protocol: "otel_protocol",
  headers: "otel_headers",
} as const;

/**
 * Setting keys whose values are secrets and must be masked by GET /api/settings.
 * The destinations blob holds every destination's headers, so it is masked as a
 * whole; the Observability page reads it through /api/settings/otel/destinations,
 * which masks just the headers.
 */
export const OTEL_SECRET_KEYS: string[] = [OTEL_SETTING_KEYS.destinations, LEGACY_OTEL_DESTINATION_KEYS.headers];

/** Stands in for saved headers in anything sent to the browser. */
export const MASKED_HEADERS = "***";

export type OtelProtocol = "http/protobuf" | "http/json" | "grpc";
export const OTEL_PROTOCOLS: OtelProtocol[] = ["http/protobuf", "http/json", "grpc"];

export type OtelRole = "app" | "worker" | "integrations";

export type OtelSignal = "traces" | "metrics" | "logs";
export const OTEL_SIGNALS: OtelSignal[] = ["traces", "metrics", "logs"];

/** One destination as saved in `otel_destinations` (and edited in the UI). */
export interface StoredOtelDestination {
  id: string;
  name: string;
  enabled: boolean;
  /** Blank means the protocol's localhost default. */
  endpoint: string;
  protocol: OtelProtocol;
  /** Raw `key=value` text, as typed. */
  headers: string;
  traces: boolean;
  metrics: boolean;
  logs: boolean;
}

/** A destination ready for an exporter: endpoint resolved, headers parsed. */
export interface OtelDestination extends Omit<StoredOtelDestination, "headers"> {
  headers: Record<string, string>;
}

export interface OtelConfig {
  enabled: boolean;
  destinations: OtelDestination[];
  serviceName: string;
  resourceAttributes: Record<string, string>;
  traces: boolean;
  metrics: boolean;
  logs: boolean;
  /** Trace individual Prisma queries (operation + SQL spans). Off by default — it's a lot of spans. */
  dbSpans: boolean;
  /**
   * Put a redacted summary of each tool call's input on its `execute_tool` span as
   * `gen_ai.tool.call.arguments` (see src/lib/tool-arguments.ts). Off by default — it is content.
   */
  toolArguments: boolean;
  /** Also export each process's console output as log records. */
  captureConsole: boolean;
  /** Pass the collector settings to the spawned Claude Code CLI (its own telemetry). */
  forwardToAgent: boolean;
  /** Which destination the CLI gets; see agentDestination() for the fallback. */
  agentDestinationId: string;
  metricIntervalMs: number;
}

export const DEFAULT_OTEL_SERVICE_NAME = "claude-task-manager";
export const DEFAULT_METRIC_INTERVAL_SECONDS = 60;
const MIN_METRIC_INTERVAL_SECONDS = 5;

export function defaultEndpoint(protocol: OtelProtocol): string {
  return protocol === "grpc" ? "http://localhost:4317" : "http://localhost:4318";
}

/**
 * Parses the `k=v,k2=v2` format used by OTEL_EXPORTER_OTLP_HEADERS and
 * OTEL_RESOURCE_ATTRIBUTES. Newlines work as separators too (friendlier in a
 * textarea), values are URL-decoded as the spec says, and malformed entries
 * are skipped rather than failing the whole config.
 *
 * Lines copied from a collector's YAML (`Authorization: "Bearer abc"`) are
 * accepted too: a line whose key is followed by a colon uses the colon form.
 * The key check keeps the colon form from catching `key=value` lines whose
 * value contains a colon. Quotes around a value are stripped in both forms.
 */
export function parseKeyValueList(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (const part of raw.split(/[,\n]/)) {
    const yaml = part.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (yaml) {
      out[yaml[1]] = unquote(yaml[2]);
      continue;
    }
    const eq = part.indexOf("=");
    const key = eq > 0 ? part.slice(0, eq).trim() : "";
    if (!key) continue;
    const rawValue = unquote(part.slice(eq + 1));
    let value = rawValue;
    try { value = decodeURIComponent(rawValue); } catch { /* keep as-is */ }
    out[key] = value;
  }
  return out;
}

/** Inverse of parseKeyValueList, for env vars handed to child processes. */
export function formatKeyValueList(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join(",");
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true";
}

function parseProtocol(value: unknown): OtelProtocol {
  return OTEL_PROTOCOLS.includes(value as OtelProtocol) ? (value as OtelProtocol) : "http/protobuf";
}

/** A short random id for a new destination (crypto.randomUUID needs a secure context in browsers). */
export function newDestinationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Coerces one untrusted JSON entry into a destination, or null if it has no id. */
export function normalizeStoredDestination(raw: unknown): StoredOtelDestination | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    id,
    name: str(r.name).trim(),
    enabled: bool(r.enabled, true),
    endpoint: str(r.endpoint).trim(),
    protocol: parseProtocol(r.protocol),
    headers: str(r.headers),
    traces: bool(r.traces, true),
    metrics: bool(r.metrics, true),
    logs: bool(r.logs, true),
  };
}

/** Parses a destinations list, dropping malformed entries and duplicate ids. */
export function parseStoredDestinations(raw: unknown): StoredOtelDestination[] {
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: StoredOtelDestination[] = [];
  for (const entry of list) {
    const d = normalizeStoredDestination(entry);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

/** Id given to the destination synthesised from the pre-destinations settings. */
export const LEGACY_DESTINATION_ID = "default";

/**
 * The saved destinations. Until the list has been saved once, the old
 * single-collector settings stand in as one destination, so an existing setup
 * keeps exporting exactly as before.
 */
export function readStoredDestinations(settings: Record<string, string | undefined>): StoredOtelDestination[] {
  const saved = settings[OTEL_SETTING_KEYS.destinations];
  if (saved !== undefined) return parseStoredDestinations(saved);
  const legacy = LEGACY_OTEL_DESTINATION_KEYS;
  return [{
    id: LEGACY_DESTINATION_ID,
    name: "",
    enabled: true,
    endpoint: (settings[legacy.endpoint] ?? "").trim(),
    protocol: parseProtocol(settings[legacy.protocol]),
    headers: settings[legacy.headers] ?? "",
    traces: true,
    metrics: true,
    logs: true,
  }];
}

export function resolveDestination(stored: StoredOtelDestination): OtelDestination {
  return {
    ...stored,
    endpoint: stored.endpoint.trim() || defaultEndpoint(stored.protocol),
    headers: parseKeyValueList(stored.headers),
  };
}

/** What logs and the UI call a destination: its name, else its endpoint. */
export function destinationLabel(d: Pick<StoredOtelDestination, "name" | "endpoint" | "protocol">): string {
  return d.name.trim() || d.endpoint.trim() || defaultEndpoint(d.protocol);
}

/** Copy for the browser: headers replaced by MASKED_HEADERS when set. */
export function maskDestinations(list: StoredOtelDestination[]): StoredOtelDestination[] {
  return list.map((d) => ({ ...d, headers: d.headers.trim() ? MASKED_HEADERS : "" }));
}

/**
 * Undoes maskDestinations() on a list coming back from the browser: a
 * destination whose headers are still MASKED_HEADERS keeps its saved headers.
 * A masked value with no saved counterpart (unknown id) becomes empty rather
 * than being stored as a literal "***".
 */
export function mergeDestinationSecrets(
  incoming: StoredOtelDestination[],
  saved: StoredOtelDestination[],
): StoredOtelDestination[] {
  const byId = new Map(saved.map((d) => [d.id, d]));
  return incoming.map((d) =>
    d.headers === MASKED_HEADERS ? { ...d, headers: byId.get(d.id)?.headers ?? "" } : d,
  );
}

export function parseOtelSettings(settings: Record<string, string | undefined>): OtelConfig {
  const k = OTEL_SETTING_KEYS;
  const interval = Number(settings[k.metricIntervalSeconds]);
  const intervalSeconds = Number.isFinite(interval) && interval > 0
    ? Math.max(MIN_METRIC_INTERVAL_SECONDS, Math.floor(interval))
    : DEFAULT_METRIC_INTERVAL_SECONDS;
  return {
    enabled: flag(settings[k.enabled], false),
    destinations: readStoredDestinations(settings).map(resolveDestination),
    serviceName: (settings[k.serviceName] ?? "").trim() || DEFAULT_OTEL_SERVICE_NAME,
    resourceAttributes: parseKeyValueList(settings[k.resourceAttributes]),
    traces: flag(settings[k.tracesEnabled], true),
    metrics: flag(settings[k.metricsEnabled], true),
    logs: flag(settings[k.logsEnabled], true),
    dbSpans: flag(settings[k.dbSpans], false),
    toolArguments: flag(settings[k.toolArguments], false),
    captureConsole: flag(settings[k.captureConsole], true),
    forwardToAgent: flag(settings[k.forwardToAgent], false),
    agentDestinationId: (settings[k.agentDestination] ?? "").trim(),
    metricIntervalMs: intervalSeconds * 1000,
  };
}

/** The destinations one signal is exported to: on globally, and on for the (enabled) destination. */
export function exportTargets(config: OtelConfig, signal: OtelSignal): OtelDestination[] {
  if (!config.enabled || !config[signal]) return [];
  return config.destinations.filter((d) => d.enabled && d[signal]);
}

/** True when at least one signal would actually be exported somewhere. */
export function isOtelActive(config: OtelConfig): boolean {
  return OTEL_SIGNALS.some((signal) => exportTargets(config, signal).length > 0);
}

/**
 * The URL an exporter posts one signal to. For OTLP/HTTP the configured value
 * is a base endpoint and `/v1/<signal>` is appended (the same rule as
 * OTEL_EXPORTER_OTLP_ENDPOINT) unless the user already pasted a full signal
 * URL. gRPC uses the endpoint as-is.
 */
export function signalUrl(config: Pick<OtelDestination, "endpoint" | "protocol">, signal: OtelSignal): string {
  const base = config.endpoint.trim();
  if (config.protocol === "grpc") return base;
  if (/\/v1\/(traces|metrics|logs)\/?$/.test(base)) {
    return base.replace(/\/v1\/(traces|metrics|logs)\/?$/, `/v1/${signal}`);
  }
  return `${base.replace(/\/+$/, "")}/v1/${signal}`;
}

/**
 * Sampling rule applied to every span. Prisma query spans are only kept when
 * they belong to something — a task run or an HTTP request. A query with no
 * parent is background polling (the worker checks the queue every 5s), and
 * tracing it would bury the useful traces. Children of dropped spans are
 * dropped too, so a trace is never left with holes.
 */
export function shouldRecordSpan(spanName: string, parent: { sampled: boolean } | undefined): boolean {
  if (parent) return parent.sampled;
  return !spanName.startsWith("prisma:");
}

/** Prisma span types that are pure overhead (client-side bookkeeping, not database work). */
export const IGNORED_PRISMA_SPANS = [/^prisma:client:(serialize|connect|compile)$/];

/** Service name reported by one process: the three processes show up as separate services. */
export function serviceNameFor(config: Pick<OtelConfig, "serviceName">, role: OtelRole): string {
  return `${config.serviceName}-${role}`;
}

/** Stable string that changes whenever anything affecting the exporters changes. */
export function otelConfigFingerprint(config: OtelConfig): string {
  if (!isOtelActive(config)) return "off";
  const sorted = (o: Record<string, string>) => Object.keys(o).sort().map((key) => [key, o[key]]);
  return JSON.stringify({
    ...config,
    // Disabled destinations have no exporters, so editing one restarts nothing.
    destinations: config.destinations
      .filter((d) => d.enabled)
      .map((d) => ({ ...d, headers: sorted(d.headers) })),
    resourceAttributes: sorted(config.resourceAttributes),
    // None of these needs an exporter restart: the agent settings are read per
    // spawn, dbSpans toggles Prisma's instrumentation in place and toolArguments is
    // read per tool call.
    forwardToAgent: undefined,
    agentDestinationId: undefined,
    dbSpans: undefined,
    toolArguments: undefined,
  });
}

/**
 * The destination the Claude CLI exports to. It takes a single OTLP endpoint,
 * so with several destinations one has to be chosen: the configured one when
 * it is enabled and takes metrics or logs, otherwise the first that does.
 */
export function agentDestination(config: OtelConfig): OtelDestination | null {
  const usable = config.destinations.filter(
    (d) => d.enabled && ((config.metrics && d.metrics) || (config.logs && d.logs)),
  );
  return usable.find((d) => d.id === config.agentDestinationId) ?? usable[0] ?? null;
}

/**
 * Environment for a spawned Claude Code CLI so it exports its own metrics and
 * events (token usage, tool decisions, API latency…) to agentDestination(),
 * tagged with the task id for correlation. Empty unless forwarding is on.
 */
export function agentTelemetryEnv(
  config: OtelConfig,
  extraResourceAttributes: Record<string, string> = {},
): Record<string, string> {
  if (!isOtelActive(config) || !config.forwardToAgent) return {};
  const dest = agentDestination(config);
  if (!dest) return {};
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: config.metrics && dest.metrics ? "otlp" : "none",
    OTEL_LOGS_EXPORTER: config.logs && dest.logs ? "otlp" : "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: dest.protocol,
    // The base endpoint: the CLI appends /v1/<signal> itself for OTLP/HTTP.
    OTEL_EXPORTER_OTLP_ENDPOINT: dest.protocol === "grpc"
      ? dest.endpoint
      : dest.endpoint.trim().replace(/\/v1\/(traces|metrics|logs)\/?$/, "").replace(/\/+$/, ""),
    OTEL_METRIC_EXPORT_INTERVAL: String(config.metricIntervalMs),
    OTEL_RESOURCE_ATTRIBUTES: formatKeyValueList({ ...config.resourceAttributes, ...extraResourceAttributes }),
  };
  if (Object.keys(dest.headers).length > 0) {
    env.OTEL_EXPORTER_OTLP_HEADERS = formatKeyValueList(dest.headers);
  }
  return env;
}

/**
 * The config the current process's telemetry runtime last loaded (src/lib/otel.ts
 * keeps it on globalThis), or null when telemetry was never initialised here.
 * Read through this rather than importing otel.ts so light modules — e.g. the
 * CLI provider — don't drag the whole SDK into every bundle that imports them.
 */
export function currentOtelConfig(): OtelConfig | null {
  return (globalThis as unknown as { __ctmOtel?: { config: OtelConfig } }).__ctmOtel?.config ?? null;
}
