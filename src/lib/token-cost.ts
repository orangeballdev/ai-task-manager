// Pricing in USD per million tokens (MTok)
//
// Current models only, matching the dropdown in src/lib/models.ts. When a model is
// replaced, replace its row here too. An ID with no row (an older model) gets no
// price at all rather than a guessed one; costs already stored on finished tasks are
// unaffected.
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // Anthropic Claude models
  "claude-fable-5-2": { inputPerMTok: 8, outputPerMTok: 40 },
  "claude-mythos-5-2": { inputPerMTok: 8, outputPerMTok: 40 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  // Base rate for prompts up to 100K tokens ($0.50 / $2.50 beyond); this table can't tier.
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  // OpenAI models
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

export function findPricing(model: string): { inputPerMTok: number; outputPerMTok: number } | null {
  const normalized = model.toLowerCase();
  if (MODEL_PRICING[normalized]) return MODEL_PRICING[normalized];
  // A dated or suffixed form of a listed ID (e.g. "gpt-4o-2024-08-06"). Only this
  // direction: a shorter, older ID such as "claude-opus-5" must not borrow the price of
  // "claude-opus-5-5". Longest key first so "gpt-4o-mini" wins over "gpt-4o".
  const keys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(`${key}-`)) return MODEL_PRICING[key];
  }
  return null;
}

export function calculateCost(
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  // CLI providers (Claude and Codex alike) run against the user's subscription —
  // no per-token billing, so any price we computed would be fiction.
  if (provider === "cli" || provider === "codex-cli") return null;

  const pricing = findPricing(model);
  if (!pricing) return null;

  return (inputTokens / 1_000_000) * pricing.inputPerMTok +
         (outputTokens / 1_000_000) * pricing.outputPerMTok;
}

export function estimateCostForCli(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!model) return null;
  const pricing = findPricing(model);
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.inputPerMTok +
         (outputTokens / 1_000_000) * pricing.outputPerMTok;
}

/**
 * Cost of a run (or part of one, e.g. a team stage) the way the task page reports it:
 * metered providers are priced directly, a Claude subscription (`cli`) is an estimate
 * at API prices, and anything without a known price (Codex, unknown model) is null.
 */
export function estimateRunCost(
  model: string | null,
  providerType: string | null,
  inputTokens: number,
  outputTokens: number,
): { cost: number; atApiPricing: boolean } | null {
  if (!model || !providerType) return null;
  if (providerType === "cli") {
    const cost = estimateCostForCli(model, inputTokens, outputTokens);
    return cost == null ? null : { cost, atApiPricing: true };
  }
  const cost = calculateCost(model, providerType, inputTokens, outputTokens);
  return cost == null ? null : { cost, atApiPricing: false };
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(5)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}
