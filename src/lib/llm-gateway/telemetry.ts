/**
 * One LLM gateway request as a `chat <model>` span (gen_ai semantic conventions), plus the
 * `gen_ai.client.*` metrics — so gateway traffic shows up in GenAI observability backends as
 * model calls with tokens, cache usage and finish reasons, broken down by API key.
 *
 * A streamed response ends its span when the client has read the last event, not when the
 * route returns; a client that disconnects early ends it as `error.type=cancelled`.
 */
import { SpanKind, SpanStatusCode, context, trace, type Span } from "@opentelemetry/api";
import { getTracer } from "@/lib/otel";
import { recordGenAiOperation } from "@/lib/gen-ai-otel";
import { errorTypeOf, genAiProviderName, usageAttributes, type GenAiUsage } from "@/lib/gen-ai-telemetry";
import type { AuthedApiKey } from "@/lib/api-auth";
import type { GatewayProvider } from "./backends";
import type { GatewayFormat } from "./http";
import { resolveGatewayModel } from "./routing";
import { recordGatewayUsage } from "./usage-record";

interface RequestLike {
  model?: string | null;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  temperature?: number | null;
  stream?: boolean | null;
}

interface UsageAccumulator<T> {
  push(item: T): void;
  result(): GenAiUsage;
}

export class GatewayCall {
  private readonly span: Span;
  private readonly startedAt = Date.now();
  private readonly providerName: string;
  private readonly requestModel?: string;
  private readonly format: GatewayFormat;
  private readonly provider: Pick<GatewayProvider, "id" | "name" | "type">;
  private readonly apiKey: Pick<AuthedApiKey, "id" | "name">;
  private ended = false;

  constructor(format: GatewayFormat, provider: GatewayProvider, body: RequestLike, apiKey: Pick<AuthedApiKey, "id" | "name">) {
    this.providerName = genAiProviderName(provider.type);
    this.format = format;
    this.provider = { id: provider.id, name: provider.name, type: provider.type };
    this.apiKey = { id: apiKey.id, name: apiKey.name };
    // The model this request will actually ask for: the client's id when the provider can run
    // it, else the connection's configured model (unknown for a CLI with none configured).
    this.requestModel = resolveGatewayModel(body.model, provider) || body.model?.trim() || undefined;
    const maxTokens = body.max_tokens ?? body.max_completion_tokens;
    this.span = getTracer().startSpan(this.requestModel ? `chat ${this.requestModel}` : "chat", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": this.providerName,
        ...(this.requestModel ? { "gen_ai.request.model": this.requestModel } : {}),
        ...(maxTokens != null ? { "gen_ai.request.max_tokens": maxTokens } : {}),
        ...(body.temperature != null ? { "gen_ai.request.temperature": body.temperature } : {}),
        "ctm.llm_gateway.format": format,
        "ctm.llm_gateway.stream": !!body.stream,
        "ctm.provider.type": provider.type,
        "ctm.provider.name": provider.name,
        "ctm.api_key.id": apiKey.id,
        "ctm.api_key.name": apiKey.name,
      },
    });
  }

  /** Runs the upstream call inside the span, so its HTTP client spans nest under it. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return context.with(trace.setSpan(context.active(), this.span), fn);
  }

  succeed(usage: GenAiUsage): void {
    if (this.ended) return;
    this.span.setAttributes(usageAttributes(usage));
    if (!this.requestModel && usage.responseModel) {
      this.span.updateName(`chat ${usage.responseModel}`);
      this.span.setAttribute("gen_ai.request.model", usage.responseModel);
    }
    this.finish(usage);
  }

  fail(err: unknown, errorType = errorTypeOf(err), usage: GenAiUsage = {}): void {
    if (this.ended) return;
    this.span.setAttributes(usageAttributes(usage));
    this.span.setAttribute("error.type", errorType);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    if (err instanceof Error) this.span.recordException(err);
    this.finish(usage, errorType);
  }

  /** Passes a response stream through, reading usage off it and ending the span with it. */
  async *observe<T>(stream: AsyncIterable<T>, acc: UsageAccumulator<T>): AsyncGenerator<T> {
    let completed = false;
    try {
      for await (const item of stream) {
        try { acc.push(item); } catch { /* telemetry must never break the stream */ }
        yield item;
      }
      completed = true;
      this.succeed(acc.result());
    } catch (err) {
      this.fail(err, undefined, acc.result());
      throw err;
    } finally {
      if (!completed) this.fail(new Error("Client disconnected"), "cancelled", acc.result());
    }
  }

  private finish(usage: GenAiUsage, errorType?: string): void {
    this.ended = true;
    this.span.end();
    const durationMs = Date.now() - this.startedAt;
    recordGenAiOperation({
      operation: "chat",
      providerName: this.providerName,
      requestModel: this.requestModel ?? usage.responseModel,
      usage,
      errorType,
      durationS: durationMs / 1000,
    });
    // Persisted for the "Token spend by source" breakdown on /analytics.
    recordGatewayUsage({
      apiKey: this.apiKey,
      format: this.format,
      provider: this.provider,
      model: this.requestModel,
      usage,
      errorType,
      durationMs,
    });
  }
}
