import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkProvider } from "@/lib/health-check";
import { recordProviderAuthFailure } from "@/lib/provider-auth-otel";
import { healthCheckAuthFailure } from "@/lib/provider-auth-telemetry";
import { canAdoptDiskCredentials } from "@/lib/providers/cli-credentials";
import type { HealthCheckCache, ProviderHealthStatus } from "@/lib/health-check";
import { getNotificationSettings, sendLowUsageWarningNotification, getAppHost } from "@/lib/notifications";

interface DBProviderRow {
  id: string;
  name: string;
  type: string;
  isEnabled: boolean;
  configDir: string | null;
  credentialsJson: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  pkiCertData?: Uint8Array | null;
  pkiCertPassphrase?: string | null;
  proxyUrl?: string | null;
}

const CACHE_KEY = "health_check_results";
const ENABLED_KEY = "health_check_enabled";
const INTERVAL_KEY = "health_check_interval_minutes";
const MODEL_KEY = "health_check_model";

async function getSettings() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [ENABLED_KEY, INTERVAL_KEY, MODEL_KEY] } },
  });
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    enabled: map[ENABLED_KEY] !== "false",
    intervalMinutes: parseInt(map[INTERVAL_KEY] ?? "60", 10) || 60,
    model: map[MODEL_KEY] ?? "",
  };
}

async function getCachedResults(): Promise<HealthCheckCache | null> {
  const row = await prisma.setting.findUnique({ where: { key: CACHE_KEY } });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as HealthCheckCache;
  } catch {
    return null;
  }
}

async function runHealthChecks(model: string): Promise<HealthCheckCache> {
  // Include disabled CLI providers too (Claude and Codex alike) so users can keep an eye on
  // their stats while the connection is switched off. They are *listed*, not *used*:
  // `checkProvider` skips the liveness prompt and the credential write for anything
  // disabled (see DISABLED_SKIP_REASON), so a disabled provider neither spends its
  // subscription nor leaves its login in a config dir a live connection authenticates from.
  // Other disabled provider types (api/openai/pki) are skipped entirely as before.
  const providers = await prisma.aIProvider.findMany({
    where: { OR: [{ isEnabled: true }, { type: "cli" }, { type: "codex-cli" }] },
    orderBy: { createdAt: "asc" },
  });

  // A CLI provider currently powering a running task shares its on-disk credentials file
  // with the liveness probe we're about to spawn. Racing an OAuth refresh against the
  // task's own in-flight refresh can burn the rotated refresh token and produce a *real*
  // but misleading auth failure. Skip the probe for those providers — the running task is
  // itself live proof the credentials work — and check again once they're free.
  const busyProviderIds = new Set(
    (
      await prisma.task.findMany({
        where: { status: "running", aiProviderId: { not: null } },
        select: { aiProviderId: true },
      })
    ).map((t: { aiProviderId: string | null }) => t.aiProviderId!),
  );

  const results: ProviderHealthStatus[] = await Promise.all(
    (providers as DBProviderRow[]).map((p) =>
      checkProvider(p, model || undefined, {
        busy: busyProviderIds.has(p.id),
        // Two connections that leave configDir blank share one credentials file; knowing what
        // the others' logins look like lets the write step tell "my CLI rotated this" from
        // "this is someone else's account" instead of silently running as the wrong one.
        otherProviderCredentials: (providers as DBProviderRow[])
          .filter((other) => other.id !== p.id)
          .map((other) => other.credentialsJson),
      }),
    ),
  );

  // checkProvider() doesn't know about the enabled flag — annotate results afterward so the
  // UI can show a "Disabled" chip without treating the provider as unhealthy.
  const enabledById = new Map((providers as DBProviderRow[]).map((p) => [p.id, p.isEnabled]));
  for (const r of results) {
    r.isEnabled = enabledById.get(r.providerId) ?? true;
    // Expired / revoked credentials go to the logs backend as a `ctm.provider.auth_failure` event.
    const authFailure = healthCheckAuthFailure(r);
    if (authFailure) {
      recordProviderAuthFailure({
        provider: { id: r.providerId, name: r.providerName, type: r.providerType },
        source: "health_check",
        reason: authFailure,
      });
    }
  }

  // Sync any token refresh that happened during the CLI liveness check back to the DB.
  // The liveness check writes DB creds to disk then runs claude, which may refresh the OAuth
  // token. Without syncing back, the next write-to-disk overwrites the refreshed token with
  // the stale DB copy and burns the rotated refresh token, causing auth failures.
  // Codex refreshes its login the same way, into auth.json inside CODEX_HOME.
  for (const p of providers as DBProviderRow[]) {
    if (p.type !== "cli" && p.type !== "codex-cli") continue;
    // Nothing was written or spawned for a disabled provider, so there is no refresh of ours
    // to collect — and pulling here would copy whichever *enabled* connection shares the dir
    // onto this row, quietly merging two accounts into one.
    if (!p.isEnabled) continue;
    try {
      const { join } = await import("path");
      const { homedir } = await import("os");
      const { readFile: readFileAsync } = await import("fs/promises");
      const isCodex = p.type === "codex-cli";
      const dir = p.configDir?.trim() || join(homedir(), isCodex ? ".codex" : ".claude");
      const credFile = join(dir, isCodex ? "auth.json" : ".credentials.json");
      // Only adopt from a dir this provider owns: what's in a shared dir may be another
      // connection's login, and copying it here is what makes an account swap permanent.
      if (!canAdoptDiskCredentials(dir, p.id)) continue;
      const freshCreds = (await readFileAsync(credFile, "utf8")).trim();
      if (freshCreds && freshCreds !== (p.credentialsJson ?? "").trim()) {
        await prisma.aIProvider.update({ where: { id: p.id }, data: { credentialsJson: freshCreds } });
      }
    } catch { /* non-fatal */ }
  }

  const cache: HealthCheckCache = {
    results,
    checkedAt: new Date().toISOString(),
  };

  await prisma.setting.upsert({
    where: { key: CACHE_KEY },
    create: { key: CACHE_KEY, value: JSON.stringify(cache) },
    update: { value: JSON.stringify(cache) },
  });

  // Check for low usage warnings and send notifications
  try {
    const notifSettings = await getNotificationSettings(prisma);
    if (notifSettings.onLowUsageWarning && notifSettings.emailEnabled) {
      const appHost = await getAppHost(prisma);
      for (const result of results) {
        if (!result.usageMetrics) continue;
        if (result.isEnabled === false) continue; // don't nag about a provider turned off on purpose

        const utilization = result.usageMetrics.seven_day.utilization;
        const resetTime = new Date(result.usageMetrics.seven_day.resets_at);
        const now = new Date();
        const hoursUntilReset = (resetTime.getTime() - now.getTime()) / (1000 * 60 * 60);

        // Send notification if: utilization > 50% (i.e., < 50% remaining) AND < 48 hours until reset
        if (utilization > 50 && hoursUntilReset < 48 && hoursUntilReset > 0) {
          // Check if we already sent a notification recently (within last 24 hours) to avoid spam
          const lastNotifKey = `notification_low_usage_${result.providerId}_sent_at`;
          const lastNotif = await prisma.setting.findUnique({ where: { key: lastNotifKey } });
          const lastNotifTime = lastNotif ? new Date(lastNotif.value).getTime() : 0;
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

          if (lastNotifTime < oneDayAgo) {
            const resetsAtFormatted = resetTime.toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });

            await sendLowUsageWarningNotification(
              notifSettings,
              result.providerName,
              utilization,
              Math.ceil(hoursUntilReset),
              resetsAtFormatted,
              appHost,
            );

            // Update the last notification timestamp
            await prisma.setting.upsert({
              where: { key: lastNotifKey },
              create: { key: lastNotifKey, value: new Date().toISOString() },
              update: { value: new Date().toISOString() },
            });
          }
        }
      }
    }
  } catch {
    // Non-fatal — notification failures shouldn't break health checks
  }

  return cache;
}

export async function GET() {
  const settings = await getSettings();
  const cached = await getCachedResults();

  return NextResponse.json({
    enabled: settings.enabled,
    intervalMinutes: settings.intervalMinutes,
    model: settings.model,
    cache: cached,
  });
}

export async function POST() {
  const settings = await getSettings();

  if (!settings.enabled) {
    return NextResponse.json({ error: "Health checks are disabled" }, { status: 400 });
  }

  const cache = await runHealthChecks(settings.model);
  return NextResponse.json(cache);
}
