/**
 * Per-provider usage cap (`AIProvider.maxUsagePercent`).
 *
 * A subscription connection (Claude `cli`, `codex-cli`) is shared with the user's own manual
 * use of the same account. Without a cap the task manager happily spends a plan window down to
 * 0% and leaves nothing for the person at the keyboard. Setting e.g. 90% keeps 10% of every
 * 5-hour and weekly window free: once either window reaches the cap, the provider is treated as
 * throttled until that window resets.
 *
 * Enforcement piggybacks on the existing throttle machinery rather than inventing a parallel
 * one: an over-cap provider gets `throttledUntil` set to the window's reset time, so every
 * selection path (smart picker, explicit pins, default/fallback tiers, auto-switch, holding
 * tasks as `throttled`) already does the right thing. The checks are:
 *   - the smart picker skips accounts at their cap (`pickSmartProvider`),
 *   - the worker calls `enforceUsageCap()` on the provider it's about to use, at pre-flight and
 *     again just before spawning,
 *   - the periodic Claude usage check throttles over-cap accounts and never clears that early,
 *   - `revalidateProviderThrottle()` keeps a cap throttle in place while the window is still over.
 *
 * The cap is checked when a task is picked up, not continuously, so a long run that starts just
 * under the cap can finish above it.
 */

import { prisma } from "@/lib/db";
import {
  codexUsageMetrics,
  isOverUsageCap,
  isWindowSpent,
  normalizeMaxUsagePercent,
  usageResetTime,
  type OAuthUsageMetrics,
} from "@/lib/health-check";
import { defaultUsageLookup } from "@/lib/smart-provider";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaLike = any;

export interface UsageCapProviderShape {
  id: string;
  name: string;
  type: string;
  configDir?: string | null;
  credentialsJson?: string | null;
  maxUsagePercent?: number | null;
}

export interface UsageCapResult {
  /** The cap that was hit, as a percentage. */
  cap: number;
  /** Which window reached it. */
  window: "5-hour" | "7-day";
  /** That window's utilisation when we looked. */
  usedPercent: number;
  /** When the provider becomes usable again (written to `throttledUntil`). */
  throttledUntil: Date;
}

export type UsageCapLookup = (provider: UsageCapProviderShape) => Promise<OAuthUsageMetrics | null>;

/** Live usage for a subscription CLI connection, or null when it isn't available. */
export const defaultUsageCapLookup: UsageCapLookup = async (provider) => {
  if (provider.type === "cli") return defaultUsageLookup(provider);
  if (provider.type === "codex-cli") return (await codexUsageMetrics(provider.configDir ?? null)) ?? null;
  return null;
};

/** Whether a provider has a cap that can actually be enforced (i.e. we can read its usage). */
export function hasEnforceableUsageCap(provider: Pick<UsageCapProviderShape, "type" | "maxUsagePercent">): boolean {
  return (provider.type === "cli" || provider.type === "codex-cli") && normalizeMaxUsagePercent(provider.maxUsagePercent) < 100;
}

/**
 * Pure: has this provider reached its cap given these usage figures, and until when?
 * Null when there's no cap, no figures, or the provider is under its cap.
 */
export function evaluateUsageCap(
  metrics: OAuthUsageMetrics | null | undefined,
  maxUsagePercent: number | null | undefined,
  now: Date = new Date(),
): UsageCapResult | null {
  const cap = normalizeMaxUsagePercent(maxUsagePercent);
  if (!metrics || cap >= 100 || !isOverUsageCap(metrics, cap)) return null;
  const fiveHourOver = isWindowSpent(metrics.five_hour, cap);
  const window = fiveHourOver ? "5-hour" : "7-day";
  const usedPercent = fiveHourOver ? metrics.five_hour.utilization : metrics.seven_day.utilization;
  const reset = usageResetTime(metrics, cap);
  const throttledUntil = reset && reset.getTime() > now.getTime() ? reset : new Date(now.getTime() + 3_600_000);
  return { cap, window, usedPercent, throttledUntil };
}

/**
 * If `provider` has reached its usage cap, mark it throttled until the capped window resets and
 * return the details; otherwise return null and leave it alone. Lookup failures are treated as
 * "under the cap" — we never take a connection out of rotation on no evidence.
 */
export async function enforceUsageCap(
  provider: UsageCapProviderShape | null | undefined,
  client: PrismaLike = prisma,
  now: Date = new Date(),
  lookup: UsageCapLookup = defaultUsageCapLookup,
): Promise<UsageCapResult | null> {
  if (!provider || !hasEnforceableUsageCap(provider)) return null;
  const metrics = await lookup(provider).catch(() => null);
  const verdict = evaluateUsageCap(metrics, provider.maxUsagePercent, now);
  if (!verdict) return null;
  await client.aIProvider
    .update({ where: { id: provider.id }, data: { throttledUntil: verdict.throttledUntil } })
    .catch(() => {});
  return verdict;
}

/** Log line for a provider being skipped because of its cap. */
export function describeUsageCapHit(providerName: string, result: UsageCapResult): string {
  return `Provider "${providerName}" has used ${Math.round(result.usedPercent)}% of its ${result.window} window, reaching its ${result.cap}% usage cap. Not using it until ${result.throttledUntil.toISOString()}.`;
}

/**
 * Validate a `maxUsagePercent` from an API body: undefined when absent, null when invalid
 * (not a whole number from 1 to 100), the number otherwise.
 */
export function parseMaxUsagePercentInput(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}
