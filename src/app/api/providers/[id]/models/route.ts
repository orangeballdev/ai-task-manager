import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ANTHROPIC_MODELS as ANTHROPIC_FALLBACK, OPENAI_MODELS as OPENAI_FALLBACK, CODEX_MODELS, latestVersionsOnly } from "@/lib/models";

async function fetchAnthropicModels(apiKey: string, baseURL?: string | null): Promise<{ id: string; label: string }[]> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
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
  // Include known models first, then any gpt-/o- models the account has access to
  const live = response.data
    .filter((m) => m.id.match(/^(gpt-|o\d)/))
    .sort((a, b) => b.created - a.created)
    .map((m) => ({ id: m.id, label: m.id }));
  // Merge: known labels for known IDs, plus anything extra
  const seen = new Set<string>();
  const result: { id: string; label: string }[] = [];
  for (const m of live) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const fallback = OPENAI_FALLBACK.find((f) => f.id === m.id);
    result.push(fallback ?? m);
  }
  // Add any known models not returned by the API (so they still appear even if API is stale)
  for (const f of OPENAI_FALLBACK) {
    if (!seen.has(f.id)) result.push(f);
  }
  return result;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await prisma.aIProvider.findUnique({ where: { id } });
  if (!provider) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (provider.type === "api" && provider.apiKey) {
    try {
      const models = await fetchAnthropicModels(provider.apiKey, provider.baseUrl);
      return NextResponse.json({ models, defaultModel: provider.model });
    } catch {
      // Fall through to static list
    }
  }

  if (provider.type === "openai" && provider.apiKey) {
    try {
      const models = await fetchOpenAIModels(provider.apiKey, provider.baseUrl);
      return NextResponse.json({ models, defaultModel: provider.model });
    } catch {
      // Fall through to static list
    }
  }

  // CLI and fallback: return static list
  const models = provider.type === "codex-cli" ? CODEX_MODELS : provider.type === "openai" ? OPENAI_FALLBACK : ANTHROPIC_FALLBACK;
  return NextResponse.json({ models, defaultModel: provider.model });
}
