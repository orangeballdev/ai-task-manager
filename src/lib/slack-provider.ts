/**
 * Provider fallback rules for the Slack bot.
 *
 * The Slack integration can pin a specific AI provider (Settings → Integrations) and a task
 * proposal can pin one too (the provider dropdown on the proposal form). Both of those are
 * *ids stored days earlier* — the provider they name can be disabled, deleted or rate-limited
 * by the time Slack actually needs it. Historically that broke the bot outright ("No AI
 * provider configured") even when other enabled providers were sitting right there.
 *
 * Everything here is pure so it can be unit-tested without Slack or a database;
 * `src/integrations/slack.ts` owns the I/O. The usability rule itself is *not* redefined
 * here — it delegates to `isProviderUsable` in `smart-provider.ts` so Slack can't drift
 * away from the worker's idea of which connections can run something right now.
 */

import { isProviderUsable } from "./smart-provider";

/** The provider fields Slack's fallback logic actually needs. */
export interface SlackProviderChoice {
  id: string;
  name: string;
  type: string;
  isDefault?: boolean | null;
  isEnabled: boolean;
  throttledUntil?: Date | string | null;
}

/** Which tier the chosen provider came from — for logging and for telling the user. */
export type SlackProviderSource = "preferred" | "default" | "fallback" | null;

export interface SlackProviderPick<T extends SlackProviderChoice> {
  provider: T | null;
  source: SlackProviderSource;
  /**
   * True when a provider *was* requested by id but something else got used — i.e. the
   * requested one is disabled, deleted, or (when alternatives exist) rate-limited.
   */
  fellBack: boolean;
}

function isThrottled(p: SlackProviderChoice, now: Date): boolean {
  return !!p.throttledUntil && new Date(p.throttledUntil).getTime() > now.getTime();
}

/**
 * Choose which provider a proposal form should show, given every provider that exists.
 *
 * Order:
 *  1. the requested provider, if it's enabled (a rate-limited one is still a legitimate
 *     choice for a task that will run later — the worker waits it out or hands off),
 *  2. the default provider, if it's usable right now,
 *  3. any usable provider,
 *  4. any enabled provider (everything is throttled — still better than nothing),
 *  5. null, when nothing is enabled at all.
 *
 * A *disabled* provider is never returned: disabling is an unambiguous "don't use this",
 * so a stale id pointing at one always falls through to a working connection.
 */
export function pickProposalProvider<T extends SlackProviderChoice>(
  candidates: T[],
  preferredId?: string | null,
  now: Date = new Date(),
): SlackProviderPick<T> {
  const enabled = candidates.filter((p) => p.isEnabled);

  const preferred = preferredId ? enabled.find((p) => p.id === preferredId) : undefined;
  if (preferred) return { provider: preferred, source: "preferred", fellBack: false };

  // Anything below this point is a substitution — flag it so callers can say so out loud.
  const fellBack = !!preferredId;

  const usable = enabled.filter((p) => isProviderUsable(p, now));
  const defaultUsable = usable.find((p) => p.isDefault);
  if (defaultUsable) return { provider: defaultUsable, source: "default", fellBack };
  if (usable.length) return { provider: usable[0], source: "fallback", fellBack };

  // Everything enabled is currently rate-limited. Still offer one — the task the user is
  // about to create runs later, by which time the limit has usually reset.
  const throttled = enabled.find((p) => p.isDefault) ?? enabled[0];
  if (throttled) return { provider: throttled, source: "fallback", fellBack };

  return { provider: null, source: null, fellBack };
}

/** Menu label for a provider — flags the rate-limited ones so the choice is informed. */
export function providerOptionLabel(p: SlackProviderChoice, now: Date = new Date()): string {
  return isThrottled(p, now) ? `${p.name} (rate-limited)` : p.name;
}

/** Which vendor's API a model id belongs to, or null when it's unrecognised. */
export function modelVendor(model?: string | null): "anthropic" | "openai" | null {
  if (!model) return null;
  const id = model.trim().toLowerCase();
  if (!id) return null;
  if (id.startsWith("claude")) return "anthropic";
  if (/^(gpt-|chatgpt|o\d)/.test(id)) return "openai";
  return null;
}

/**
 * Which vendor's models a provider type serves. `codex-cli` drives OpenAI's Codex CLI, so it
 * takes `gpt-*` ids — grouping it with the Anthropic types would strip a perfectly valid
 * model override off every Codex proposal.
 */
export function providerVendor(type?: string | null): "anthropic" | "openai" {
  return type === "openai" || type === "codex-cli" ? "openai" : "anthropic";
}

/**
 * Whether a model id can be handed to this provider. Unrecognised ids pass — self-hosted and
 * proxied deployments use arbitrary names — but a `gpt-*` id must never be sent to an
 * Anthropic connection (or vice versa), which is exactly what happens when a pinned provider
 * falls back to one from another vendor and its model override tags along.
 */
export function modelFitsProvider(model: string | null | undefined, providerType: string | null | undefined): boolean {
  const vendor = modelVendor(model);
  if (!vendor) return true;
  return vendor === providerVendor(providerType);
}

/**
 * The model a proposal form should show for `providerType`, given the models that provider
 * actually offers. Keeps the user's pick when the provider still lists it (or when it's a
 * plausible custom id for that vendor) and otherwise falls back to the provider's first model
 * rather than leaving a stale id from a different vendor on the proposal.
 */
export function pickProposalModel(
  preferred: string | null | undefined,
  models: { id: string; label: string }[],
  providerType?: string | null,
): string {
  const wanted = preferred?.trim();
  if (wanted) {
    if (models.some((m) => m.id === wanted)) return wanted;
    // Not listed, but not obviously wrong for this vendor either (custom/proxied deployments).
    if (!models.length && modelFitsProvider(wanted, providerType)) return wanted;
  }
  return models[0]?.id ?? "";
}

/**
 * The model override to actually use for a Slack chat turn. The integration config pins a
 * model alongside a provider; once we've fallen back to a *different* provider that model may
 * belong to another vendor, in which case dropping it (and using the provider's own default)
 * is the only way the call can succeed.
 */
export function resolveConfiguredModel(
  configuredModel: string | null | undefined,
  provider: { type?: string | null; model?: string | null } | null,
): string | null {
  if (!provider) return null;
  if (configuredModel && modelFitsProvider(configuredModel, provider.type)) return configuredModel;
  return provider.model ?? null;
}
