export interface ModelOption {
  id: string;
  label: string;
}

// ONLY THE MOST RECENT VERSION OF EACH MODEL BELONGS IN THIS LIST.
//
// The dropdown shows one entry per model family (Opus, Sonnet, Haiku, Fable, …) —
// the newest release of each. Older point releases (Opus 4.7/4.6/4.5, Sonnet 4.5, …)
// are deliberately omitted: they still work if a provider is pinned to one, but they
// clutter the picker and nobody should be choosing them for new work. When a new
// version ships, REPLACE the family's entry rather than adding a second row.
//
// Anything not in this list is still reachable via the "Custom…" option in the
// provider settings, and live model lists fetched from the API are run through
// latestVersionsOnly() so they follow the same one-row-per-family rule.
//
// Only use exact, documented model ID strings here — never invent one.
//   Claude Opus 5.5   -> claude-opus-5-5   (current default — long-running agentic coding)
//   Claude Sonnet 5.5 -> claude-sonnet-5-5 (best speed/intelligence balance)
//   Claude Haiku 5.5  -> claude-haiku-5-5  (fastest/cheapest)
//   Claude Fable 5.2  -> claude-fable-5-2  (most capable overall, highest cost)
// Claude Mythos 5.2 (claude-mythos-5-2) is intentionally absent: it is only available to
// verified organizations, and will surface automatically via the live model list for
// orgs that have access.
export const ANTHROPIC_MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
];

// Same rule as above: newest release per family only. These six are each a distinct
// model rather than successive versions of one, so all six stay listed.
export const OPENAI_MODELS: ModelOption[] = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
];

/** Models exposed by the locally authenticated Codex CLI. */
export const CODEX_MODELS: ModelOption[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
];

export const ALL_KNOWN_MODELS: ModelOption[] = [...ANTHROPIC_MODELS, ...OPENAI_MODELS];

export const DEFAULT_ASSISTANT_MODEL = "claude-opus-5-5";

/** Model a Codex CLI provider uses when neither the task nor the connection pins one. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/** Claude model families, in the order they appear inside a model ID. */
const CLAUDE_FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"] as const;

/**
 * Returns a stable family key for a model ID, or null if the ID isn't a Claude
 * model we know how to group (those are passed through untouched).
 *
 * claude-opus-4-8, claude-opus-4-5-20251101 and claude-3-opus-20240229 all
 * collapse to "claude-opus".
 */
function claudeFamily(id: string): string | null {
  const lower = id.toLowerCase();
  if (!lower.startsWith("claude")) return null;
  const family = CLAUDE_FAMILIES.find((f) => lower.includes(f));
  return family ? `claude-${family}` : null;
}

/** An 8-digit run is a release date (e.g. 20251001), not a version segment. */
function isDateSegment(segment: string): boolean {
  return segment.length === 8;
}

/**
 * Version number of a model ID, as a comparable tuple of its numeric segments.
 * "claude-opus-4-8" -> [4, 8]; "claude-3-5-sonnet-20241022" -> [3, 5].
 * Release-date suffixes are excluded so `claude-haiku-4-5` and
 * `claude-haiku-4-5-20251001` compare as the same version.
 */
function versionTuple(id: string): number[] {
  return (id.match(/\d+/g) ?? [])
    .filter((segment) => !isDateSegment(segment))
    .map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True if `candidate` should replace `current` as the family's representative. */
function isNewer(candidate: ModelOption, current: ModelOption): boolean {
  const diff = compareVersions(versionTuple(candidate.id), versionTuple(current.id));
  if (diff !== 0) return diff > 0;
  // Same version: prefer the undated alias (claude-haiku-4-5 over ...-20251001).
  const candidateDated = (candidate.id.match(/\d+/g) ?? []).some(isDateSegment);
  const currentDated = (current.id.match(/\d+/g) ?? []).some(isDateSegment);
  return currentDated && !candidateDated;
}

/**
 * Collapses a model list down to the most recent version of each model family,
 * so live lists fetched from a provider API follow the same rule as the static
 * lists above. Input order is preserved, and IDs we can't classify (custom
 * deployments, OpenAI models, gateway aliases) are passed through unchanged.
 */
export function latestVersionsOnly(models: ModelOption[]): ModelOption[] {
  const winnerByFamily = new Map<string, ModelOption>();
  const passthrough: ModelOption[] = [];

  for (const model of models) {
    const family = claudeFamily(model.id);
    if (!family) {
      passthrough.push(model);
      continue;
    }
    const current = winnerByFamily.get(family);
    if (!current || isNewer(model, current)) winnerByFamily.set(family, model);
  }

  const kept = new Set([...winnerByFamily.values(), ...passthrough]);
  return models.filter((m) => kept.has(m));
}

export function getModelsForProviderType(type?: string | null): ModelOption[] {
  if (type === "codex-cli") return CODEX_MODELS;
  return type === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;
}

/**
 * Whether a Claude model accepts `output_config.effort`.
 *
 * Returns false only when we *know* the model rejects it (Haiku 4.5 and older,
 * Sonnet 4.5 and older, Opus before 4.5) — sending the parameter there is a 400. IDs we
 * can't classify (gateway aliases, custom deployments, non-Claude models) return
 * true so an explicit choice still reaches the API rather than being silently
 * dropped.
 */
export function modelSupportsEffort(model: string | null | undefined): boolean {
  if (!model) return true;
  const family = claudeFamily(model);
  if (!family) return true;
  const version = versionTuple(model);
  switch (family) {
    case "claude-fable":
    case "claude-mythos":
      return true;
    case "claude-opus":
      return compareVersions(version, [4, 5]) >= 0;
    case "claude-sonnet":
      return compareVersions(version, [4, 6]) >= 0;
    case "claude-haiku":
      return compareVersions(version, [5, 0]) >= 0; // Haiku 5.5 takes effort; 4.5 and older don't
    default:
      return false;
  }
}
