/**
 * GET /api/models?type=anthropic|openai
 *
 * Returns available models for the given provider type.
 * For Anthropic, dynamically fetches from the Anthropic API (free — no tokens consumed,
 * it's a plain metadata endpoint). Falls back to a static list if no API key is configured
 * or if the request fails.
 *
 * Results are cached in-process for 5 minutes to avoid redundant API calls.
 */
import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/smart-provider";
import { ANTHROPIC_MODELS, OPENAI_MODELS, latestVersionsOnly } from "@/lib/models";

// Simple in-memory cache so repeated page loads don't hammer the Anthropic API.
const cache = new Map<string, { models: { id: string; label: string }[]; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchAnthropicModels(apiKey: string, baseURL?: string | null): Promise<{ id: string; label: string }[]> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  // models.list() is a free metadata call — it does NOT consume any tokens.
  const response = await client.models.list({ limit: 100 });
  const models = response.data
    .filter((m) => m.id.startsWith("claude-"))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((m) => ({ id: m.id, label: m.display_name || m.id }));
  // Only the newest release of each model family — see src/lib/models.ts.
  return latestVersionsOnly(models);
}

async function fetchOpenAIModels(apiKey: string, baseURL?: string | null): Promise<{ id: string; label: string }[]> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.models.list();
  const live = response.data
    .filter((m) => m.id.match(/^(gpt-|o\d)/))
    .sort((a, b) => b.created - a.created)
    .map((m) => ({ id: m.id, label: m.id }));
  const seen = new Set<string>();
  const result: { id: string; label: string }[] = [];
  for (const m of live) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const known = OPENAI_MODELS.find((f) => f.id === m.id);
    result.push(known ?? m);
  }
  for (const f of OPENAI_MODELS) {
    if (!seen.has(f.id)) result.push(f);
  }
  return result;
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") ?? "anthropic";

  // Return from cache if still fresh
  const cached = cache.get(type);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ models: cached.models, source: "cache" });
  }

  try {
    if (type === "anthropic") {
      // Borrow the key from whichever Anthropic API provider would actually be used — never a
      // disabled one, whose credentials the user has deliberately taken out of service.
      const { provider } = await getProvider({ type: "api" });

      if (provider?.apiKey) {
        const models = await fetchAnthropicModels(provider.apiKey, provider.baseUrl);
        cache.set(type, { models, expiresAt: Date.now() + CACHE_TTL_MS });
        return NextResponse.json({ models, source: "api" });
      }
    }

    if (type === "openai") {
      const { provider } = await getProvider({ type: "openai" });

      if (provider?.apiKey) {
        const models = await fetchOpenAIModels(provider.apiKey, provider.baseUrl);
        cache.set(type, { models, expiresAt: Date.now() + CACHE_TTL_MS });
        return NextResponse.json({ models, source: "api" });
      }
    }
  } catch {
    // Fall through to static fallback
  }

  // Static fallback — used when no API key is configured or the API call fails
  const models = type === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;
  return NextResponse.json({ models, source: "static" });
}
