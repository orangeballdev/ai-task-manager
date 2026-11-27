import { prisma } from "@/lib/db";
import { checkProvider, type HealthCheckCache } from "@/lib/health-check";

const CACHE_KEY = "health_check_results";

/**
 * Re-run the health check for one provider and replace its entry in the cached results, so a
 * fixed login (e.g. after "Sign in with Claude") stops showing as failing straight away rather
 * than at the next scheduled check. No-op when there is no cache yet or health checks are off.
 *
 * Unlike the full run in `/api/providers/health`, this doesn't sync a refreshed token back from
 * disk: it's only called right after new credentials were stored, which the CLI won't refresh.
 */
export async function refreshProviderHealth(providerId: string): Promise<void> {
  const [cacheRow, enabledRow, modelRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: CACHE_KEY } }),
    prisma.setting.findUnique({ where: { key: "health_check_enabled" } }),
    prisma.setting.findUnique({ where: { key: "health_check_model" } }),
  ]);
  if (!cacheRow?.value || enabledRow?.value === "false") return;

  let cache: HealthCheckCache;
  try {
    cache = JSON.parse(cacheRow.value) as HealthCheckCache;
  } catch {
    return;
  }

  type ProviderRow = Parameters<typeof checkProvider>[0] & { isEnabled: boolean };
  const providers = (await prisma.aIProvider.findMany()) as ProviderRow[];
  const provider = providers.find((p: ProviderRow) => p.id === providerId);
  if (!provider) return;

  const busy = (await prisma.task.count({ where: { status: "running", aiProviderId: providerId } })) > 0;
  const result = await checkProvider(provider, modelRow?.value || undefined, {
    busy,
    otherProviderCredentials: providers.filter((p: ProviderRow) => p.id !== providerId).map((p: ProviderRow) => p.credentialsJson),
  });
  result.isEnabled = provider.isEnabled;

  // Re-read so a full health run that finished meanwhile isn't overwritten wholesale.
  const latestRow = await prisma.setting.findUnique({ where: { key: CACHE_KEY } });
  let latest: HealthCheckCache = cache;
  try {
    if (latestRow?.value) latest = JSON.parse(latestRow.value) as HealthCheckCache;
  } catch { /* keep the copy read above */ }

  const results = latest.results.some((r) => r.providerId === providerId)
    ? latest.results.map((r) => (r.providerId === providerId ? result : r))
    : [...latest.results, result];

  await prisma.setting.update({
    where: { key: CACHE_KEY },
    data: { value: JSON.stringify({ ...latest, results }) },
  });
}
