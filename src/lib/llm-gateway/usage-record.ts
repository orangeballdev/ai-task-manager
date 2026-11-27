/**
 * Persists one LLM gateway request's token usage as an `LlmGatewayUsage` row, so /analytics
 * can compare gateway spend with task-run spend (see src/lib/token-spend.ts). Called by
 * `GatewayCall` when a request ends. Fire-and-forget: a DB error is logged, never thrown,
 * because bookkeeping must not break a response the client is already reading.
 */
import { prisma } from "@/lib/db";
import { calculateCost } from "@/lib/token-cost";
import type { GenAiUsage } from "@/lib/gen-ai-telemetry";

export interface GatewayUsageRecord {
  apiKey: { id: string; name: string };
  format: string;
  provider: { id: string; name: string; type: string };
  model?: string;
  usage: GenAiUsage;
  errorType?: string;
  durationMs: number;
}

export function recordGatewayUsage(r: GatewayUsageRecord): void {
  const inputTokens = r.usage.inputTokens ?? 0;
  const outputTokens = r.usage.outputTokens ?? 0;
  const model = r.usage.responseModel ?? r.model ?? null;
  // Same rule as tasks: subscription CLIs have no per-token billing (calculateCost → null).
  const estimatedCost = model ? calculateCost(model, r.provider.type, inputTokens, outputTokens) : null;
  prisma.llmGatewayUsage
    .create({
      data: {
        apiKeyId: r.apiKey.id,
        apiKeyName: r.apiKey.name,
        format: r.format,
        providerId: r.provider.id,
        providerName: r.provider.name,
        providerType: r.provider.type,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens: r.usage.cacheReadTokens ?? 0,
        cacheCreationTokens: r.usage.cacheCreationTokens ?? 0,
        estimatedCost,
        errorType: r.errorType ?? null,
        durationMs: Math.max(0, Math.round(r.durationMs)),
      },
    })
    .catch((err: unknown) => {
      console.error("[llm-gateway] failed to record usage:", err instanceof Error ? err.message : err);
    });
}
