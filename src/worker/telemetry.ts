/**
 * Worker-side OpenTelemetry instrumentation (see src/lib/otel.ts for the runtime).
 *
 * `runTask()` has a couple of dozen exit paths, so rather than threading a span
 * through all of them the main loop wraps each run in `traceTaskRun()`: it opens
 * a `task.run` span, and once `runTask()` settles it reads the task row back and
 * records the outcome (status, provider, tokens, cost) on the span and as
 * metrics. Spans are kept in a map by task id so the worker's `log()` helper can
 * correlate each TaskLog line with its task's trace.
 */
import { SpanKind, SpanStatusCode, context, trace, type Attributes, type Span } from "@opentelemetry/api";
import { emitLog, getMeter, getTracer, onMeterReady, type LogLevel } from "../lib/otel";
import { recordEvaluation, recordGenAiOperation } from "../lib/gen-ai-otel";
import { agentRunErrorType, agentRunUsage, genAiProviderName, taskOutcomeEvaluation, usageAttributes, type AgentRunOutcome } from "../lib/gen-ai-telemetry";

export { genAiProviderName };

const taskSpans = new Map<string, Span>();

const TASK_LOG_LEVEL: Record<"info" | "error" | "system", LogLevel> = {
  info: "info",
  system: "info",
  error: "error",
};

/**
 * Attribute naming: standard OpenTelemetry semantic conventions where one
 * exists (gen_ai.* for the model/provider/token usage), and a `ctm.` prefix
 * for everything specific to this app, as the conventions recommend for
 * custom attributes.
 *
 * `gen_ai.usage.*` and `gen_ai.request.model` live only on the `invoke_agent`
 * spans (see `withAgentSpan()`), never on `task.run`: GenAI backends count every
 * span that names a model as a model call and sum its tokens, so carrying them
 * on both would double count. `task.run` uses `ctm.task.*` for the same figures.
 */

/** Mirrors a TaskLog line as an OTel log record, correlated with the task's span. */
export function emitTaskLog(taskId: string, content: string, level: "info" | "error" | "system", member?: string | null): void {
  emitLog(content, TASK_LOG_LEVEL[level], {
    "ctm.log.source": "task",
    "ctm.task.id": taskId,
    "ctm.task.log_level": level,
    ...(member ? { "ctm.team.member": member } : {}),
  }, taskSpans.get(taskId));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaLike = any;

interface FinishedTaskRow {
  status: string;
  title: string;
  provider: string | null;
  model: string | null;
  priority: string | null;
  effort: string | null;
  retryCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  teamId: string | null;
  aiProvider: { name: string; type: string } | null;
  _count: { repos: number };
}

/** Wraps one `runTask()` call in a `task.run` span and records its outcome. */
export async function traceTaskRun(prisma: PrismaLike, taskId: string, run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  const span = getTracer().startSpan("task.run", { kind: SpanKind.INTERNAL, attributes: { "ctm.task.id": taskId } });
  taskSpans.set(taskId, span);
  // Remember where this run lives, so a review that arrives hours later can join its trace.
  if (span.isRecording()) {
    const { traceId, spanId } = span.spanContext();
    prisma.task.update({ where: { id: taskId }, data: { telemetryTraceId: traceId, telemetrySpanId: spanId } }).catch(() => {});
  }
  getMeter().createCounter("ctm.tasks.started", { description: "Task runs started by the worker" }).add(1);

  let thrown: unknown;
  try {
    await context.with(trace.setSpan(context.active(), span), run);
  } catch (err) {
    thrown = err;
  }

  try {
    const row: FinishedTaskRow | null = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        status: true, title: true, provider: true, model: true, priority: true, effort: true,
        retryCount: true, inputTokens: true, outputTokens: true, estimatedCost: true, teamId: true,
        aiProvider: { select: { name: true, type: true } },
        _count: { select: { repos: true } },
      },
    });
    const status = thrown ? "failed" : row?.status ?? "unknown";
    const common: Attributes = {
      "ctm.task.status": status,
      "gen_ai.provider.name": genAiProviderName(row?.aiProvider?.type ?? row?.provider),
      "ctm.provider.type": row?.aiProvider?.type ?? row?.provider ?? "unknown",
      "ctm.provider.name": row?.aiProvider?.name ?? "unknown",
      "ctm.task.team": !!row?.teamId,
    };
    span.setAttributes({
      ...common,
      "ctm.task.title": row?.title ?? "",
      "ctm.task.priority": row?.priority ?? "normal",
      "ctm.task.retry_count": row?.retryCount ?? 0,
      "ctm.task.repo_count": row?._count.repos ?? 0,
      ...(row?.model ? { "ctm.task.model": row.model } : {}),
      ...(row?.effort ? { "ctm.ai.effort": row.effort } : {}),
      ...(row?.inputTokens != null ? { "ctm.task.input_tokens": row.inputTokens } : {}),
      ...(row?.outputTokens != null ? { "ctm.task.output_tokens": row.outputTokens } : {}),
      ...(row?.estimatedCost != null ? { "ctm.ai.cost.usd": row.estimatedCost } : {}),
    });
    if (thrown || status === "failed") {
      span.setStatus({ code: SpanStatusCode.ERROR, message: thrown instanceof Error ? thrown.message : `Task ${status}` });
      if (thrown instanceof Error) span.recordException(thrown);
    }

    const outcome = taskOutcomeEvaluation(status);
    if (outcome) {
      recordEvaluation(outcome, { taskId, providerType: row?.aiProvider?.type ?? row?.provider, model: row?.model }, span);
    }

    const meter = getMeter();
    meter.createCounter("ctm.tasks.finished", { description: "Task runs that ended, by resulting status" }).add(1, common);
    meter.createHistogram("ctm.task.duration", { description: "Wall-clock time of one task run", unit: "s" })
      .record((Date.now() - startedAt) / 1000, common);
    const tokens = meter.createCounter("ctm.ai.tokens", { description: "Tokens used by task runs", unit: "{token}" });
    if (row?.inputTokens) tokens.add(row.inputTokens, { ...common, "gen_ai.token.type": "input" });
    if (row?.outputTokens) tokens.add(row.outputTokens, { ...common, "gen_ai.token.type": "output" });
    if (row?.estimatedCost) {
      meter.createCounter("ctm.ai.cost", { description: "Estimated spend of task runs", unit: "USD" }).add(row.estimatedCost, common);
    }
  } catch {
    /* telemetry must never affect the task */
  } finally {
    span.end();
    taskSpans.delete(taskId);
  }

  if (thrown) throw thrown;
}

/**
 * Runs `fn` in a child span of the active span — normally the task's `task.run`
 * (or an enclosing child such as `agent.execute`) — falling back to the task's
 * span by id when async context was lost along the way.
 */
export async function withTaskSpan<T>(taskId: string, name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  const fallback = taskSpans.get(taskId);
  const parentContext = !trace.getActiveSpan() && fallback ? trace.setSpan(context.active(), fallback) : context.active();
  const span = getTracer().startSpan(name, { attributes: { "ctm.task.id": taskId, ...attributes } }, parentContext);
  try {
    return await context.with(trace.setSpan(parentContext, span), fn);
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

export interface AgentSpanInfo {
  /** `gen_ai.agent.name` — the span is named `invoke_agent <agentName>`. */
  agentName: string;
  /** `gen_ai.agent.id`, when the agent has a stable id (the task id for a task's own agent). */
  agentId?: string;
  /** Our provider type (`cli`, `api`, …). */
  providerType: string;
  /** The model the run was asked to use, if known; the provider may report the one that answered. */
  requestModel?: string;
  attributes?: Attributes;
}

/**
 * One agent run (a single-agent task, or one team stage) as an `invoke_agent <agent>` span,
 * following the gen_ai semantic conventions: the run's aggregate token usage, the model that
 * answered, finish reason and `error.type` go on the span, plus the `gen_ai.client.*` metrics.
 * The task id is the conversation id, so a task's retries group together.
 */
export async function withAgentSpan<T extends AgentRunOutcome>(taskId: string, info: AgentSpanInfo, fn: () => Promise<T>): Promise<T> {
  const providerName = genAiProviderName(info.providerType);
  return withTaskSpan(taskId, `invoke_agent ${info.agentName.slice(0, 120)}`, {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": info.agentName,
    ...(info.agentId ? { "gen_ai.agent.id": info.agentId } : {}),
    "gen_ai.provider.name": providerName,
    "gen_ai.conversation.id": taskId,
    "ctm.provider.type": info.providerType,
    ...(info.requestModel ? { "gen_ai.request.model": info.requestModel } : {}),
    ...info.attributes,
  }, async () => {
    const startedAt = Date.now();
    const result = await fn();
    const usage = agentRunUsage(result);
    const errorType = agentRunErrorType(result);
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttributes(usageAttributes(usage));
      // A span must name a model to count as a model call; fall back to the one that answered.
      if (!info.requestModel && usage.responseModel) span.setAttribute("gen_ai.request.model", usage.responseModel);
      if (errorType) {
        span.setAttribute("error.type", errorType);
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.error ?? errorType });
      }
    }
    recordGenAiOperation({
      operation: "invoke_agent",
      providerName,
      requestModel: info.requestModel || usage.responseModel,
      usage,
      errorType,
      durationS: (Date.now() - startedAt) / 1000,
    });
    return result;
  });
}

/** Marks the current child span as failed without throwing (for results that report failure). */
export function markSpanFailed(message: string, errorType?: string): void {
  const span = trace.getActiveSpan();
  span?.setStatus({ code: SpanStatusCode.ERROR, message });
  if (errorType) span?.setAttribute("error.type", errorType);
}

/** Queue-depth gauges, read from the DB at each metric export. */
export function registerWorkerGauges(prisma: PrismaLike, runningTasks: Set<string>): void {
  onMeterReady((meter) => {
    meter.createObservableGauge("ctm.worker.running_tasks", { description: "Tasks this worker is running right now" })
      .addCallback((result) => result.observe(runningTasks.size));
    meter.createObservableGauge("ctm.tasks.queued", { description: "Tasks waiting to run, by status" })
      .addCallback(async (result) => {
        try {
          const groups: { status: string; _count: { _all: number } }[] = await prisma.task.groupBy({
            by: ["status"],
            where: { isRecurringTemplate: false, status: { in: ["pending", "paused", "throttled"] } },
            _count: { _all: true },
          });
          const counts: Record<string, number> = { pending: 0, paused: 0, throttled: 0 };
          for (const g of groups) counts[g.status] = g._count._all;
          for (const [status, count] of Object.entries(counts)) result.observe(count, { "ctm.task.status": status });
        } catch {
          /* skip this observation */
        }
      });
  });
}
