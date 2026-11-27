import { NextResponse } from "next/server";
import { getProvider } from "@/lib/smart-provider";
import { ANTHROPIC_MODELS, getModelsForProviderType, latestVersionsOnly } from "@/lib/models";

async function fetchAnthropicModels(
  apiKey: string,
  baseURL?: string | null,
): Promise<{ id: string; label: string }[]> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.models.list({ limit: 100 });
  const models = response.data
    .filter((m) => m.id.startsWith("claude-"))
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .map((m) => ({ id: m.id, label: m.display_name || m.id }));
  // Only the newest release of each model family — see src/lib/models.ts.
  return latestVersionsOnly(models);
}

/**
 * GET /api/providers/smart/models
 *
 * Returns the model list for the provider that Smart Provider would pick right
 * now, so the task form can show a model selector even when Smart Provider is
 * selected as the AI provider.
 *
 * Falls back to the Anthropic static list when no provider can be resolved.
 */
export async function GET() {
  try {
    // When everything is throttled there's still an answer — the provider whose limit resets
    // soonest is the one the task will run on, so name it rather than showing nothing.
    const { provider: picked, throttledFallback } = await getProvider({ useSmartProvider: true });
    const provider = picked ?? throttledFallback;

    if (provider) {
      const throttledUntil = picked ? null : throttledFallback?.throttledUntil ?? null;

      // API provider — try to fetch live models
      if (provider.type === "api" && provider.apiKey) {
        try {
          const models = await fetchAnthropicModels(provider.apiKey, provider.baseUrl);
          return NextResponse.json({
            models,
            defaultModel: provider.model,
            resolvedProviderName: provider.name,
            throttledUntil,
          });
        } catch {
          // fall through to static list
        }
      }

      // CLI or fallback
      return NextResponse.json({
        models: getModelsForProviderType(provider.type),
        defaultModel: provider.model,
        resolvedProviderName: provider.name,
        throttledUntil,
      });
    }
  } catch {
    // fall through
  }

  // No provider resolved — return Anthropic static list as sensible default
  return NextResponse.json({
    models: ANTHROPIC_MODELS,
    defaultModel: null,
    resolvedProviderName: null,
    throttledUntil: null,
  });
}
