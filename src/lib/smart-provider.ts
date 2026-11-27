/**
 * Smart Provider Picker
 *
 * Selects the best available AI provider based on:
 * 1. Provider is enabled and not currently throttled
 * 2. Claude subscriptions: the account whose weekly usage renews soonest goes first, so
 *    unused capacity isn't thrown away when the window resets; remaining percentage breaks
 *    ties (see `rankProvidersForSmartMode`).
 * 3. Fallback to API/OpenAI providers when no suitable CLI provider is found.
 */

import { prisma } from "@/lib/db";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  extractExpiresAt,
  extractOAuthAccessToken,
  fetchOAuthUsage,
  isUsageExhausted,
  normalizeMaxUsagePercent,
  readCliExtraUsage,
  type OAuthUsageMetrics,
} from "@/lib/health-check";
import { extractCodexExpiresAt } from "@/lib/providers/codex-exec";

/**
 * Provider types that run a locally-authenticated CLI against a subscription rather than a
 * metered API key. The smart picker prefers these — using them costs nothing extra, and any
 * capacity left unused when the plan window rolls over is simply lost.
 */
const SUBSCRIPTION_CLI_TYPES = new Set(["cli", "codex-cli"]);

export function isSubscriptionCliType(type?: string | null): boolean {
  return SUBSCRIPTION_CLI_TYPES.has(type ?? "");
}

// Minimal shape of the prisma client this module needs, so tests can pass a lightweight
// stub instead of hitting a real database.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaLike = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderRecord = any;

interface UsabilityShape {
  isEnabled: boolean;
  throttledUntil?: Date | string | null;
}

interface SmartPickableShape {
  isEnabled: boolean;
  excludeFromSmartPicker?: boolean | null;
  throttledUntil?: Date | string | null;
}

/**
 * The single "can this provider run something right now?" check. A provider is usable when
 * it's enabled and not currently rate-limited. Every provider-selection path in the app —
 * the smart picker, `getProvider`, the worker's retry logic, hail-mary bursts — must agree
 * on this, otherwise one code path happily spawns a CLI call against a connection another
 * path has already written off.
 */
export function isProviderUsable(provider: UsabilityShape | null | undefined, now: Date = new Date()): boolean {
  if (!provider) return false;
  if (!provider.isEnabled) return false;
  if (provider.throttledUntil && new Date(provider.throttledUntil).getTime() > now.getTime()) return false;
  return true;
}

/**
 * Whether the smart picker (either the per-task opt-in or the global default) may
 * auto-select this provider. Beyond the usual usability check, a provider can be opted out of
 * auto-selection specifically via `excludeFromSmartPicker` — set from the AI Providers settings
 * page — while remaining fully usable when chosen explicitly (a task's `aiProviderId`, the
 * global default, or the last-resort fallback tier). This lets someone keep a provider around
 * for manual/default use without the smart picker ever grabbing it on its own.
 */
export function isSmartPickable(provider: SmartPickableShape | null | undefined, now: Date = new Date()): boolean {
  if (!isProviderUsable(provider, now)) return false;
  if (provider?.excludeFromSmartPicker) return false;
  return true;
}

// Matches any enabled provider that isn't currently throttled. Shared so `getProvider`'s
// last-resort tier and `findAlternateProvider` can't drift apart.
function usableWhere(now: Date) {
  return {
    isEnabled: true,
    OR: [{ throttledUntil: null }, { throttledUntil: { lte: now } }],
  };
}

/**
 * Any usable provider other than `excludeId` (one id, or several — e.g. every connection a
 * task has already failed to authenticate with), for handing a task off when its current
 * provider hits a rate limit or loses its login mid-run.
 */
export async function findAlternateProvider(
  excludeId: string | string[],
  client: PrismaLike = prisma,
  now: Date = new Date(),
): Promise<ProviderRecord | null> {
  const excluded = Array.isArray(excludeId) ? excludeId : [excludeId];
  return client.aIProvider.findFirst({
    where: { id: { notIn: excluded }, ...usableWhere(now) },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The enabled provider whose rate limit resets soonest. Used to schedule work for the moment
 * capacity comes back rather than failing it outright when everything is throttled.
 */
export async function findSoonestThrottledProvider(
  client: PrismaLike = prisma,
  type?: string,
): Promise<ProviderRecord | null> {
  return client.aIProvider.findFirst({
    where: { isEnabled: true, throttledUntil: { not: null }, ...(type ? { type } : {}) },
    orderBy: { throttledUntil: "asc" },
  });
}

/**
 * Credential expiry (epoch ms) for a subscription CLI provider, or 0 when unknown.
 *
 * Claude and Codex store their logins in different shapes — Claude has a plain `expiresAt`,
 * Codex only has JWTs — so the parse is per type. "Unknown" must never be mistaken for
 * "expired": it just makes the provider a lower-priority pick.
 */
function parseExpiresAt(type: string, credentialsJson: string | null): number {
  if (!credentialsJson) return 0;
  try {
    return type === "codex-cli" ? extractCodexExpiresAt(credentialsJson) : extractExpiresAt(credentialsJson);
  } catch {
    return 0;
  }
}

/**
 * Looks up a Claude subscription's live usage windows. Injectable so tests don't hit the
 * network; returns null when the figures aren't available (no token, API down, 401 on a
 * stale access token, …).
 */
export type UsageLookup = (provider: ProviderRecord) => Promise<OAuthUsageMetrics | null>;

// The picker runs on every task pick-up (and for some UI routes), so don't ask the usage API
// the same question more than once a minute per connection. Failures are cached too, so a
// dead endpoint can't add a 10s stall to every selection.
const USAGE_CACHE_MS = 60_000;
const usageCache = new Map<string, { at: number; token: string; metrics: OAuthUsageMetrics | null }>();

/** Exported for tests — the cache is process-local and otherwise invisible. */
export function resetSmartPickerUsageCache(): void {
  usageCache.clear();
}

function readClaudeCredentials(provider: ProviderRecord): string | null {
  if (provider.credentialsJson) return provider.credentialsJson;
  const dir = provider.configDir?.trim() || join(homedir(), ".claude");
  try {
    return readFileSync(join(dir, ".credentials.json"), "utf8");
  } catch {
    return null;
  }
}

export const defaultUsageLookup: UsageLookup = async (provider) => {
  if (provider.type !== "cli") return null;
  const credentialsJson = readClaudeCredentials(provider);
  const token = credentialsJson ? extractOAuthAccessToken(credentialsJson) : null;
  if (!token) return null;
  const cached = usageCache.get(provider.id);
  if (cached && cached.token === token && Date.now() - cached.at < USAGE_CACHE_MS) return cached.metrics;
  const { metrics } = await fetchOAuthUsage(token);
  usageCache.set(provider.id, { at: Date.now(), token, metrics });
  return metrics;
};

/**
 * When this account's usage allowance renews (epoch ms, or 0 if unknown) and how much of that
 * window is still left (percent, or null if unknown).
 *
 * The weekly window is what "renews soonest" means in practice: whatever is left of it when
 * it resets is gone for good, so that's the capacity worth draining first. The 5-hour window
 * resets constantly and is only used when the weekly figure is missing.
 */
//
// `maxUsagePercent` is the provider's usage cap: remaining is measured up to the cap, not up to
// 100%, since anything above it is reserved for the user's own manual use.
function usageRenewal(
  metrics: OAuthUsageMetrics,
  now: number,
  maxUsagePercent: number = 100,
): { renewsAt: number; remainingPercent: number | null } {
  const cap = normalizeMaxUsagePercent(maxUsagePercent);
  for (const w of [metrics.seven_day, metrics.five_hour]) {
    const t = w?.resets_at ? new Date(w.resets_at).getTime() : NaN;
    if (!Number.isNaN(t) && t > now) {
      const used = typeof w.utilization === "number" ? w.utilization : NaN;
      const remainingPercent = Number.isNaN(used) ? null : Math.max(0, Math.min(100, cap - used));
      return { renewsAt: t, remainingPercent };
    }
  }
  return { renewsAt: 0, remainingPercent: null };
}

/** What `rankProvidersForSmartMode` needs to know about one provider. */
export interface SmartRankCandidate {
  id: string;
  isEnabled: boolean;
  excludeFromSmartPicker?: boolean | null;
  throttledUntil?: Date | string | null;
  /** False when we know the provider can't run anything right now (e.g. usage spent). */
  available?: boolean;
  /** When the provider's credits renew. Null/absent/in the past = no renewal date. */
  renewsAt?: Date | string | number | null;
  /** Percent of the renewing allowance still left (0–100), or null when unknown. */
  remainingPercent?: number | null;
  /** Ordering for providers without a renewal date — lower tier, then lower score, wins. */
  fallbackTier?: number;
  fallbackScore?: number;
}

function renewalTime(value: SmartRankCandidate["renewsAt"], now: number): number | null {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
  return Number.isNaN(t) || t <= now ? null : t;
}

/**
 * Rank providers for Smart mode, best first. Pure — no I/O — so the ordering is unit-testable.
 *
 * Priority: renew-soonest first, so credits that are about to reset are spent rather than
 * lost (50% left renewing in 2 days beats 90% left renewing in 5). Only when two providers
 * renew at the same moment does remaining percentage break the tie, higher first. Providers
 * with no renewal date go after every provider that has one, ordered by `fallbackTier` /
 * `fallbackScore`. Disabled, unavailable (throttled, excluded, `available: false`) and
 * fully-spent (0% remaining) providers are dropped. Remaining ties keep input order.
 */
export function rankProvidersForSmartMode<T extends SmartRankCandidate>(providers: T[], now: Date = new Date()): T[] {
  const nowMs = now.getTime();
  return providers
    .filter((p) => isSmartPickable(p, now) && p.available !== false)
    .filter((p) => p.remainingPercent === null || p.remainingPercent === undefined || p.remainingPercent > 0)
    .map((p, index) => ({ p, index, renewsAt: renewalTime(p.renewsAt, nowMs) }))
    .sort((a, b) => {
      if (a.renewsAt !== null && b.renewsAt !== null) {
        if (a.renewsAt !== b.renewsAt) return a.renewsAt - b.renewsAt;
        // Unknown remaining sorts after any known figure.
        const ra = a.p.remainingPercent ?? -1;
        const rb = b.p.remainingPercent ?? -1;
        return rb - ra || a.index - b.index;
      }
      if (a.renewsAt !== null) return -1;
      if (b.renewsAt !== null) return 1;
      return (
        (a.p.fallbackTier ?? 0) - (b.p.fallbackTier ?? 0) ||
        (a.p.fallbackScore ?? 0) - (b.p.fallbackScore ?? 0) ||
        a.index - b.index
      );
    })
    .map(({ p }) => p);
}

// Tiers, lowest first. Within a tier, lower `score` wins.
// (Providers with a known renewal date rank ahead of every tier — see rankProvidersForSmartMode.)
const TIER_CREDS_KNOWN = 1; // subscription CLI, usage unknown, credential expiry readable
const TIER_CLI_UNKNOWN = 2; // subscription CLI we know nothing about
const TIER_METERED = 3; // API / OpenAI / PKI — costs money per token

export interface PickSmartProviderOptions {
  /** Override how Claude usage figures are fetched (tests). */
  usageLookup?: UsageLookup;
}

/**
 * Pick the best provider for a new task.
 *
 * Ranking (best first):
 * 1. Claude subscriptions whose usage figures we could read, ordered by when their weekly
 *    usage renews — soonest first, so capacity that's about to be reset is used rather than
 *    lost; same renewal time → higher remaining percentage first. Accounts whose usage is
 *    already spent (and not covered by usage credits) are skipped: a run there would fail
 *    straight away, and so are accounts that have reached their `maxUsagePercent` cap. The
 *    ordering itself lives in `rankProvidersForSmartMode`.
 * 2. Subscription CLIs (`cli`, `codex-cli`) without usage figures, ordered by credential expiry.
 * 3. Subscription CLIs we can't read anything about. A stored access token that has expired
 *    lands here rather than being dropped: the CLI refreshes it itself, and a genuinely dead
 *    login is handled by the worker's auth-failure hand-off.
 * 4. Metered API providers.
 *
 * Providers with `excludeFromSmartPicker` set are never considered — see `isSmartPickable`.
 */
export async function pickSmartProvider(
  client: PrismaLike = prisma,
  at: Date = new Date(),
  options: PickSmartProviderOptions = {},
): Promise<string | null> {
  const now = at.getTime();
  const usageLookup = options.usageLookup ?? defaultUsageLookup;

  // Only ever consider enabled connections — a disabled provider must never be picked to
  // run a task, even if it would otherwise score best.
  const providers: ProviderRecord[] = await client.aIProvider.findMany({
    where: { isEnabled: true },
    orderBy: { createdAt: "asc" },
  });

  const candidates = providers.filter((p) => isSmartPickable(p, at));
  if (candidates.length === 0) return null;

  // Fetch usage for every Claude subscription in parallel; a failed lookup just means "unknown".
  const usage = await Promise.all(
    candidates.map((p) => (p.type === "cli" ? usageLookup(p).catch(() => null) : Promise.resolve(null))),
  );

  const ranked = rankProvidersForSmartMode(
    candidates.map((p, i): SmartRankCandidate => {
      const base = {
        id: p.id,
        isEnabled: p.isEnabled,
        excludeFromSmartPicker: p.excludeFromSmartPicker,
        throttledUntil: p.throttledUntil,
      };
      if (!isSubscriptionCliType(p.type)) return { ...base, fallbackTier: TIER_METERED };

      const metrics = usage[i];
      if (metrics) {
        // `maxUsagePercent` < 100 reserves the top of each window for the user's own use: an
        // account that has reached its cap is as off-limits as one that's fully spent.
        if (isUsageExhausted(metrics, readCliExtraUsage(p.configDir).state, p.maxUsagePercent)) {
          return { ...base, available: false };
        }
        const { renewsAt, remainingPercent } = usageRenewal(metrics, now, p.maxUsagePercent);
        if (renewsAt > 0) {
          // A spent window that isn't "exhausted" is being covered by usage credits, so the
          // account is still usable — report the remaining figure as unknown rather than 0%.
          return { ...base, renewsAt, remainingPercent: remainingPercent === 0 ? null : remainingPercent };
        }
      }

      const expiresAt = parseExpiresAt(p.type, p.credentialsJson);
      return expiresAt > now
        ? { ...base, fallbackTier: TIER_CREDS_KNOWN, fallbackScore: expiresAt }
        : { ...base, fallbackTier: TIER_CLI_UNKNOWN };
    }),
    at,
  );

  return ranked[0]?.id ?? null;
}

export interface GetProviderOptions {
  /**
   * A provider the user explicitly picked — a task's `aiProviderId`, a request body's
   * `providerId`, the Slack integration's configured provider. Checked first: an explicit
   * choice beats smart-picking, both the per-task flag and the global setting.
   */
  explicitProviderId?: string | null;
  /** Per-task opt-in to smart picking. */
  useSmartProvider?: boolean;
  /**
   * Only consulted when `explicitProviderId` names a provider that's enabled but currently
   * throttled. False mirrors the `auto_switch_provider` setting being off: don't substitute a
   * different provider, hand the throttled one back as `throttledFallback` so the caller can
   * wait for it specifically. A *disabled* explicit provider always falls through regardless —
   * disabling is an unambiguous "don't use this".
   */
  autoSwitch?: boolean;
  /**
   * Restrict resolution to one provider type ("cli" | "api" | "openai" | "claude-pki"). For
   * callers that need a specific vendor's credentials — e.g. listing Anthropic models — rather
   * than whichever provider is best overall.
   */
  type?: string;
  now?: Date;
  /** Override how the smart picker reads Claude usage figures (tests). */
  usageLookup?: UsageLookup;
}

export interface GetProviderResult {
  /** The provider to use. Guaranteed usable right now, or null if nothing is. */
  provider: ProviderRecord | null;
  /** Which tier `provider` came from — for logging and UI labelling. */
  source: "explicit" | "smart" | "default" | "fallback" | null;
  /**
   * Only set when `provider` is null and a throttled-but-enabled provider exists: either the
   * explicit provider `autoSwitch: false` asked us to wait on, or the soonest-resetting one
   * overall. Lets time-sensitive callers schedule work instead of failing it as unconfigured.
   */
  throttledFallback: ProviderRecord | null;
}

/**
 * Resolve which AIProvider to use right now. The single source of truth for provider
 * selection — task execution, assistant features, Slack, and the UI all go through this so
 * they can't disagree about whether a given connection is usable.
 *
 * Order: explicit choice → per-task smart pick → global smart pick → enabled default →
 * any enabled provider → nothing (with the soonest-resetting throttled provider surfaced
 * as `throttledFallback`).
 */
export async function getProvider(
  options: GetProviderOptions = {},
  client: PrismaLike = prisma,
): Promise<GetProviderResult> {
  const now = options.now ?? new Date();
  const typeFilter = options.type ? { type: options.type } : {};
  const ofType = (p: ProviderRecord | null) => !!p && (!options.type || p.type === options.type);

  if (options.explicitProviderId) {
    const explicit = await client.aIProvider.findUnique({ where: { id: options.explicitProviderId } });
    if (ofType(explicit)) {
      if (isProviderUsable(explicit, now)) return { provider: explicit, source: "explicit", throttledFallback: null };
      // Throttled (but otherwise fine) and the caller opted out of switching — wait for this one.
      if (explicit?.isEnabled && options.autoSwitch === false) {
        return { provider: null, source: null, throttledFallback: explicit };
      }
    }
  }

  const smartEnabled =
    options.useSmartProvider ||
    (await client.setting.findUnique({ where: { key: "smart_provider_picker" } }))?.value === "true";

  if (smartEnabled) {
    const pickedId = await pickSmartProvider(client, now, { usageLookup: options.usageLookup });
    const picked = pickedId ? await client.aIProvider.findUnique({ where: { id: pickedId } }) : null;
    if (ofType(picked)) return { provider: picked, source: "smart", throttledFallback: null };
  }

  const defaultProvider = await client.aIProvider.findFirst({ where: { isDefault: true, isEnabled: true, ...typeFilter } });
  if (isProviderUsable(defaultProvider, now)) return { provider: defaultProvider, source: "default", throttledFallback: null };

  // Safety net: the configured default can be disabled or throttled while a perfectly good
  // connection sits unused. Without this, that combination fails as "no provider configured".
  const anyUsable = await client.aIProvider.findFirst({
    where: { ...usableWhere(now), ...typeFilter },
    orderBy: { createdAt: "asc" },
  });
  if (anyUsable) return { provider: anyUsable, source: "fallback", throttledFallback: null };

  return { provider: null, source: null, throttledFallback: await findSoonestThrottledProvider(client, options.type) };
}

/**
 * Why nothing could be resolved, phrased for the user. "No provider configured" is wrong and
 * confusing when a provider exists and is simply rate-limited, so distinguish the two.
 */
export function providerUnavailableMessage(throttledFallback: ProviderRecord | null): string {
  if (throttledFallback?.throttledUntil) {
    return `Provider "${throttledFallback.name}" is rate-limited until ${new Date(throttledFallback.throttledUntil).toLocaleString()}. No other provider is available.`;
  }
  return "No AI provider configured. Add one in Settings → AI.";
}
