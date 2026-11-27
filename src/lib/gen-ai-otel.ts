/**
 * Runtime half of the GenAI telemetry (pure half: src/lib/gen-ai-telemetry.ts): the
 * standard `gen_ai.client.*` metrics and `traceLlmCall()` for the assistant helpers. Instruments are looked up
 * per use because the meter is swapped on every telemetry reload (see src/lib/otel.ts).
 */
import { SpanKind, SpanStatusCode, context, trace, type Attributes } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { emitLog, getMeter, getTracer } from "./otel";
import {
  errorTypeOf, evaluationAttributes, genAiProviderName, usageAttributes,
  type EvaluationSubject, type GenAiEvaluation, type GenAiUsage,
} from "./gen-ai-telemetry";
import { llmCallStorage, type LlmCallUsage } from "./llm-usage-context";

export interface GenAiOperation {
  operation: "chat" | "invoke_agent";
  providerName: string;
  requestModel?: string;
  usage: GenAiUsage;
  errorType?: string;
  durationS: number;
}

/**
 * Emits a `gen_ai.evaluation.result` event (ObiStack's AI Quality page reads these),
 * correlated with `span` when the evaluated run's span is still at hand.
 */
export function recordEvaluation(e: GenAiEvaluation, subject: EvaluationSubject, span?: Span): void {
  const body = `Evaluation ${e.name}: ${e.scoreLabel} (${e.scoreValue})`;
  emitLog(body, "info", evaluationAttributes(e, subject), span, "gen_ai.evaluation.result");
}

/** Records `gen_ai.client.operation.duration` and `gen_ai.client.token.usage` for one operation. */
export function recordGenAiOperation(op: GenAiOperation): void {
  try {
    const attrs: Attributes = {
      "gen_ai.operation.name": op.operation,
      "gen_ai.provider.name": op.providerName,
      ...(op.requestModel ? { "gen_ai.request.model": op.requestModel } : {}),
      ...(op.usage.responseModel ? { "gen_ai.response.model": op.usage.responseModel } : {}),
      ...(op.errorType ? { "error.type": op.errorType } : {}),
    };
    const meter = getMeter();
    meter.createHistogram("gen_ai.client.operation.duration", { description: "GenAI operation duration", unit: "s" })
      .record(op.durationS, attrs);
    const tokens = meter.createHistogram("gen_ai.client.token.usage", { description: "Number of input and output tokens used", unit: "{token}" });
    if (op.usage.inputTokens != null) tokens.record(op.usage.inputTokens, { ...attrs, "gen_ai.token.type": "input" });
    if (op.usage.outputTokens != null) tokens.record(op.usage.outputTokens, { ...attrs, "gen_ai.token.type": "output" });
  } catch {
    /* telemetry must never affect the caller */
  }
}

export interface LlmCallInfo {
  /** Which part of the app made the call, e.g. "suggest-title" (`ctm.llm.feature`). */
  feature: string;
  provider: { type: string; name?: string | null; model?: string | null };
  /** The model asked for, when it isn't simply the provider's configured one. */
  model?: string | null;
}

/**
 * One assistant/helper model call (title suggestions, chat, Slack, …) as a `chat <model>`
 * span plus the `gen_ai.client.*` metrics. The code inside reports usage with
 * `reportLlmUsage()` & co. (src/lib/llm-usage-context.ts); the span takes the answering
 * model from that when no model was configured. Errors are recorded and re-thrown.
 */
export async function traceLlmCall<T>(info: LlmCallInfo, fn: () => Promise<T>): Promise<T> {
  const providerName = genAiProviderName(info.provider.type);
  const requestModel = info.model?.trim() || info.provider.model?.trim() || undefined;
  const startedAt = Date.now();
  const state: LlmCallUsage = { usage: {}, calls: 0 };
  const span = getTracer().startSpan(requestModel ? `chat ${requestModel}` : "chat", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": providerName,
      ...(requestModel ? { "gen_ai.request.model": requestModel } : {}),
      "ctm.llm.feature": info.feature,
      "ctm.provider.type": info.provider.type,
      ...(info.provider.name ? { "ctm.provider.name": info.provider.name } : {}),
    },
  });
  let errorType: string | undefined;
  try {
    return await context.with(trace.setSpan(context.active(), span), () => llmCallStorage.run(state, fn));
  } catch (err) {
    errorType = errorTypeOf(err);
    span.setAttribute("error.type", errorType);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    try {
      const { usage } = state;
      span.setAttributes(usageAttributes(usage));
      if (state.calls > 1) span.setAttribute("ctm.llm.model_calls", state.calls);
      if (!requestModel && usage.responseModel) {
        span.updateName(`chat ${usage.responseModel}`);
        span.setAttribute("gen_ai.request.model", usage.responseModel);
      }
      span.end();
      recordGenAiOperation({
        operation: "chat",
        providerName,
        requestModel: requestModel ?? usage.responseModel,
        usage,
        errorType,
        durationS: (Date.now() - startedAt) / 1000,
      });
    } catch {
      /* telemetry must never affect the caller */
    }
  }
}
