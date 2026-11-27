/**
 * Re-validating a provider's recorded throttle.
 *
 * `AIProvider.throttledUntil` is a *cached verdict*: it's written when a run hits a rate limit
 * (or when the periodic usage check sees a spent window) and read by every provider-selection
 * path afterwards. Nothing re-examines it until either a task succeeds on that provider or the
 * worker's 30-minute credential refresh comes around, so capacity that comes back early — the
 * window resetting, usage credits being turned on — stays invisible for up to half an hour.
 *
 * That's what makes a manual resume bounce: the task flips to `pending`, the worker picks it up,
 * the pre-flight check reads the stale flag and parks it as `throttled` again within seconds.
 *
 * So: before honouring a throttle, ask the usage API whether it's still true.
 */

import { prisma } from "@/lib/db";
import {
  creditGateMayBeStale,
  extractOAuthAccessToken,
  fetchOAuthUsage,
  isOverUsageCap,
  isUsageExhausted,
  probeCliLiveness,
  readCliExtraUsage,
  usageResetTime,
} from "@/lib/health-check";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaLike = any;

export interface ThrottledProviderShape {
  id: string;
  name: string;
  type: string;
  configDir?: string | null;
  credentialsJson?: string | null;
  throttledUntil?: Date | string | null;
  /** The provider's usage cap (percent of each plan window tasks may use; 100 = no cap). */
  maxUsagePercent?: number | null;
}

// Many parked tasks can be re-checked in a single worker poll; without this they'd each fire
// their own request at the usage API for the same answer.
const RECHECK_INTERVAL_MS = 60_000;
const lastChecked = new Map<string, number>();

/** Exported for tests — the cache is process-local and otherwise invisible. */
export function resetThrottleRevalidationCache(): void {
  lastChecked.clear();
}

function readOnDiskCredentials(configDir?: string | null): string | null {
  const dir = configDir?.trim() || join(homedir(), ".claude");
  try {
    return readFileSync(join(dir, ".credentials.json"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Is this provider *really* still throttled?
 *
 * Returns true when the throttle stands (and leaves it in place), false when it doesn't — in
 * which case `throttledUntil` is cleared in the DB so every selection path sees the provider as
 * usable immediately. Only CLI providers can be re-checked this way; an API provider's throttle
 * comes from a 429 we have no cheap way to re-test, so it's left alone until it expires.
 *
 * Anything ambiguous (no credentials, usage API down or rate-limiting us) keeps the throttle:
 * clearing it on no evidence would send tasks straight back into a failing run.
 */
export async function revalidateProviderThrottle(
  provider: ThrottledProviderShape | null | undefined,
  client: PrismaLike = prisma,
  now: Date = new Date(),
  // Injectable so tests can exercise the disagreement path without spawning a real CLI.
  probe: (configDir: string | null) => Promise<{ ok: boolean; limitMessage?: string }> = probeCliLiveness,
): Promise<boolean> {
  if (!provider?.throttledUntil) return false;
  if (new Date(provider.throttledUntil).getTime() <= now.getTime()) return false;
  // Only the Claude CLI can be re-checked early: the evidence comes from Anthropic's OAuth
  // usage API, which has no Codex equivalent. A throttled `codex-cli` provider therefore
  // waits out its `throttledUntil` the same way an API provider does.
  if (provider.type !== "cli") return true;

  const last = lastChecked.get(provider.id);
  if (last !== undefined && now.getTime() - last < RECHECK_INTERVAL_MS) return true;
  lastChecked.set(provider.id, now.getTime());

  const credentialsJson = provider.credentialsJson || readOnDiskCredentials(provider.configDir);
  if (!credentialsJson) return true;
  const token = extractOAuthAccessToken(credentialsJson);
  if (!token) return true;

  const { metrics } = await fetchOAuthUsage(token);
  if (!metrics) return true;

  const cli = readCliExtraUsage(provider.configDir);
  const cap = provider.maxUsagePercent ?? 100;

  // Still over the usage cap the user set for this provider: the throttle stands whatever the
  // credit situation is. Re-point it at the reset time of the capped window(s).
  if (isOverUsageCap(metrics, cap)) {
    const resetsAt = usageResetTime(metrics, cap);
    if (resetsAt && resetsAt.getTime() !== new Date(provider.throttledUntil).getTime()) {
      await client.aIProvider
        .update({ where: { id: provider.id }, data: { throttledUntil: resetsAt } })
        .catch(() => {});
    }
    return true;
  }

  // Account says credits are available, CLI says they're gated. The CLI's cached reason only
  // refreshes when it makes a request, so it can be stale by exactly as long as we've been
  // holding tasks back on the strength of it. Settle it with a one-token probe, which both
  // answers the question and refreshes that cache — otherwise turning credits on mid-window
  // would never be noticed and the provider would stay parked until the window reset anyway.
  if (creditGateMayBeStale(metrics, cli)) {
    const result = await probe(provider.configDir ?? null);
    if (result.ok) {
      await client.aIProvider
        .update({ where: { id: provider.id }, data: { throttledUntil: null } })
        .catch(() => {});
      return false;
    }
    return true;
  }

  if (isUsageExhausted(metrics, cli.state)) {
    // Still spent. Keep the throttle, but re-point it at the reset time the API reports now —
    // a 5-hour window that rolled over while we waited moves this *earlier*, not later.
    const resetsAt = usageResetTime(metrics);
    if (resetsAt && resetsAt.getTime() !== new Date(provider.throttledUntil).getTime()) {
      await client.aIProvider
        .update({ where: { id: provider.id }, data: { throttledUntil: resetsAt } })
        .catch(() => {});
    }
    return true;
  }

  await client.aIProvider
    .update({ where: { id: provider.id }, data: { throttledUntil: null } })
    .catch(() => {});
  return false;
}

/**
 * Re-validate every enabled provider currently carrying a throttle. Used by the un-park paths
 * (resume / retry / bulk retry) so a user who clicks Resume gets an answer based on live usage
 * rather than on whatever was true when the provider last failed.
 */
export async function revalidateThrottledProviders(
  client: PrismaLike = prisma,
  now: Date = new Date(),
): Promise<void> {
  const throttled: ThrottledProviderShape[] = await client.aIProvider.findMany({
    where: { isEnabled: true, type: "cli", throttledUntil: { gt: now } },
  });
  for (const provider of throttled) {
    await revalidateProviderThrottle(provider, client, now).catch(() => {});
  }
}
