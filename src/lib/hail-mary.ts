/**
 * Hail Mary Burst Execution Mode
 *
 * Automatically triggers high-volume job execution when significant usage capacity
 * remains within the final hours before a provider's usage quota resets.
 *
 * Design goals:
 * - Pure detection logic is isolated into testable functions
 * - Burst execution is non-blocking: it creates Task records in the DB and lets
 *   the normal worker loop pick them up, never delaying regular jobs
 * - One burst session per provider per reset window (idempotent)
 * - Per-job execution caps prevent any single job from consuming the entire quota
 */

import type { OAuthUsageMetrics, HealthCheckCache, ProviderHealthStatus } from "./health-check";
import { isProviderUsable } from "./smart-provider";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HailMaryConfig {
  /** Fraction of quota that must remain to trigger burst (e.g. 0.20 = 20%). */
  remainingThreshold: number;
  /** Hours before reset during which burst is eligible (e.g. 24 = last 24 h). */
  windowHours: number;
  /**
   * Fallback max executions per job per burst session when the job-level
   * hailMaryBurstLimit is null/undefined.
   */
  defaultBurstLimitPerJob: number;
}

export const DEFAULT_HAIL_MARY_CONFIG: HailMaryConfig = {
  remainingThreshold: 0.20,
  windowHours: 24,
  defaultBurstLimitPerJob: 1,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HailMaryEligibilityResult =
  | { eligible: true; window: "five_hour" | "seven_day"; remaining: number; resetsAt: string }
  | { eligible: false; reason: string };

export interface EligibleTemplate {
  id: string;
  title: string;
  hailMaryBurstLimit: number | null;
}

export interface BurstExecutionEntry {
  templateId: string;
  title: string;
  /** 1-based execution number within this session for this template. */
  executionNumber: number;
}

export interface BurstEvent {
  event: "hail_mary_burst_start" | "hail_mary_burst_execution" | "hail_mary_burst_end";
  provider: string;
  providerId: string;
  timestamp: string;
  /** Present on burst_start and burst_end: fraction of quota remaining. */
  remaining?: number;
  resetsAt?: string;
  /** Present on burst_start: number of eligible templates found. */
  eligibleTemplates?: number;
  /** Present on burst_execution: the task that was just spawned. */
  taskId?: string;
  taskTitle?: string;
  executionNumber?: number;
  /** Present on burst_end: cumulative counters. */
  totalTasksCreated?: number;
}

// ---------------------------------------------------------------------------
// Pure detection logic (easily unit-tested, no I/O)
// ---------------------------------------------------------------------------

/**
 * Determines whether a provider's OAuth usage metrics meet the Hail Mary
 * trigger conditions.
 *
 * Returns eligible=true when:
 *   - The usage window resets within `config.windowHours` hours from now
 *   - The fraction of quota remaining exceeds `config.remainingThreshold`
 *
 * Both the five_hour and seven_day windows are checked; the first match wins.
 */
export function checkHailMaryEligibility(
  metrics: OAuthUsageMetrics,
  config: HailMaryConfig = DEFAULT_HAIL_MARY_CONFIG,
): HailMaryEligibilityResult {
  const now = Date.now();
  const windowMs = config.windowHours * 60 * 60 * 1000;

  const windows = [
    { key: "five_hour" as const, data: metrics.five_hour },
    { key: "seven_day" as const, data: metrics.seven_day },
  ];

  for (const { key, data } of windows) {
    const resetsAt = new Date(data.resets_at).getTime();
    const msUntilReset = resetsAt - now;
    const remaining = 1 - data.utilization;

    if (msUntilReset > 0 && msUntilReset <= windowMs && remaining > config.remainingThreshold) {
      return {
        eligible: true,
        window: key,
        remaining,
        resetsAt: data.resets_at,
      };
    }
  }

  return {
    eligible: false,
    reason:
      "No usage window meets Hail Mary criteria (threshold or reset-window not satisfied)",
  };
}

/**
 * Round-robin selector: given the current position in the template list and a
 * map of already-executed counts, returns the next template that has not yet
 * hit its burst limit, plus the updated position for the next call.
 *
 * Returns null when every template has reached its limit.
 */
export function selectNextRoundRobin(
  templates: EligibleTemplate[],
  executionCounts: Map<string, number>,
  currentIndex: number,
  config: HailMaryConfig = DEFAULT_HAIL_MARY_CONFIG,
): { template: EligibleTemplate; nextIndex: number } | null {
  if (templates.length === 0) return null;

  for (let i = 0; i < templates.length; i++) {
    const idx = (currentIndex + i) % templates.length;
    const template = templates[idx];
    const count = executionCounts.get(template.id) ?? 0;
    const limit = template.hailMaryBurstLimit ?? config.defaultBurstLimitPerJob;

    if (count < limit) {
      return { template, nextIndex: (idx + 1) % templates.length };
    }
  }

  return null;
}

/**
 * Build the complete ordered execution plan for a burst session without
 * touching the database.  Useful for unit tests and capacity planning.
 *
 * Templates are cycled in round-robin order; each template is capped at its
 * hailMaryBurstLimit (or config.defaultBurstLimitPerJob when null).
 */
export function buildBurstExecutionPlan(
  templates: EligibleTemplate[],
  config: HailMaryConfig = DEFAULT_HAIL_MARY_CONFIG,
): BurstExecutionEntry[] {
  const executionCounts = new Map<string, number>();
  const plan: BurstExecutionEntry[] = [];
  let currentIndex = 0;

  while (true) {
    const next = selectNextRoundRobin(templates, executionCounts, currentIndex, config);
    if (!next) break;

    const newCount = (executionCounts.get(next.template.id) ?? 0) + 1;
    executionCounts.set(next.template.id, newCount);

    plan.push({
      templateId: next.template.id,
      title: next.template.title,
      executionNumber: newCount,
    });

    currentIndex = next.nextIndex;
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Structured event emission
// ---------------------------------------------------------------------------

/** Emit a Hail Mary lifecycle event to stdout as a JSON line. */
export function emitBurstEvent(ev: BurstEvent): void {
  console.log(JSON.stringify({ ...ev, timestamp: ev.timestamp ?? new Date().toISOString() }));
}

// ---------------------------------------------------------------------------
// DB-aware burst runner
// ---------------------------------------------------------------------------

type PrismaLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task: { findMany: (args: any) => Promise<any[]>; create: (args: any) => Promise<any>; aggregate: (args: any) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setting: { findUnique: (args: any) => Promise<any>; upsert: (args: any) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aIProvider: { findUnique: (args: any) => Promise<any> };
};

/**
 * Execute a burst session for a single provider.
 *
 * 1. Queries all recurring templates with hailMaryEligible=true.
 * 2. Builds an execution plan in round-robin order respecting hailMaryBurstLimit.
 * 3. Inserts Task instances for each planned execution.
 * 4. Emits structured log events throughout.
 *
 * Returns the number of task instances created.
 */
export async function runProviderBurst(
  prisma: PrismaLike,
  providerId: string,
  providerName: string,
  eligibility: Extract<HailMaryEligibilityResult, { eligible: true }>,
  config: HailMaryConfig = DEFAULT_HAIL_MARY_CONFIG,
): Promise<number> {
  const ts = new Date().toISOString();

  // Fetch eligible recurring templates for this provider (or provider-agnostic ones)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const templates: any[] = await prisma.task.findMany({
    where: {
      isRecurringTemplate: true,
      isEnabled: true,
      hailMaryEligible: true,
      OR: [{ aiProviderId: null }, { aiProviderId: providerId }],
    },
    include: { repos: true },
  });

  if (templates.length === 0) {
    console.log(
      JSON.stringify({
        event: "hail_mary_burst_skipped",
        provider: providerName,
        providerId,
        reason: "No hailMaryEligible templates found",
        timestamp: ts,
      }),
    );
    return 0;
  }

  const eligibleForPlan: EligibleTemplate[] = templates.map((t) => ({
    id: t.id,
    title: t.title,
    hailMaryBurstLimit: t.hailMaryBurstLimit ?? null,
  }));

  const plan = buildBurstExecutionPlan(eligibleForPlan, config);

  emitBurstEvent({
    event: "hail_mary_burst_start",
    provider: providerName,
    providerId,
    timestamp: ts,
    remaining: eligibility.remaining,
    resetsAt: eligibility.resetsAt,
    eligibleTemplates: templates.length,
  });

  let created = 0;

  for (const entry of plan) {
    const tpl = templates.find((t) => t.id === entry.templateId);
    if (!tpl) continue;

    try {
      const maxPos = await prisma.task.aggregate({ _max: { position: true } });
      const burstTag = `[Hail Mary burst #${entry.executionNumber}, provider: ${providerName}]`;
      const newTask = await prisma.task.create({
        data: {
          title: tpl.title,
          description: tpl.description,
          context: tpl.context ? `${tpl.context}\n\n${burstTag}` : burstTag,
          provider: tpl.provider,
          model: tpl.model ?? null,
          pushToMain: tpl.pushToMain,
          targetBranch: tpl.targetBranch ?? null,
          createPR: tpl.createPR,
          aiProviderId: tpl.aiProviderId ?? null,
          priority: tpl.priority ?? "normal",
          effort: tpl.effort ?? null,
          toolAccess: tpl.toolAccess ?? null,
          allowSubtasks: Boolean(tpl.allowSubtasks),
          position: (maxPos._max.position ?? -1) + 1 + created,
          recurringTemplateId: tpl.id,
          repos: {
            create: tpl.repos.map((r: { alias: string; url: string; branch?: string | null }) => ({
              alias: r.alias,
              url: r.url,
              branch: r.branch ?? null,
            })),
          },
        },
      });
      created++;

      emitBurstEvent({
        event: "hail_mary_burst_execution",
        provider: providerName,
        providerId,
        timestamp: new Date().toISOString(),
        taskId: newTask.id,
        taskTitle: tpl.title,
        executionNumber: entry.executionNumber,
      });
    } catch (err) {
      console.error(
        `[HailMary] Failed to create task for template ${tpl.id} (${tpl.title}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  emitBurstEvent({
    event: "hail_mary_burst_end",
    provider: providerName,
    providerId,
    timestamp: new Date().toISOString(),
    remaining: eligibility.remaining,
    resetsAt: eligibility.resetsAt,
    totalTasksCreated: created,
  });

  return created;
}

// ---------------------------------------------------------------------------
// Top-level detector — called from the worker loop
// ---------------------------------------------------------------------------

const BURST_SESSION_KEY_PREFIX = "hail_mary_last_burst_resetsAt_";

// Setting keys for the global Hail Mary configuration (see Settings → General).
export const HAIL_MARY_SETTING_KEYS = {
  enabled: "hail_mary_enabled",
  /** Remaining quota threshold stored as a percentage (0–100). */
  remainingThreshold: "hail_mary_remaining_threshold",
  windowHours: "hail_mary_window_hours",
  defaultBurstLimit: "hail_mary_default_burst_limit",
} as const;

export interface HailMarySettings {
  enabled: boolean;
  config: HailMaryConfig;
}

async function readSetting(prisma: PrismaLike, key: string): Promise<string | undefined> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    return row?.value ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the global Hail Mary settings from the Setting key/value store,
 * falling back to DEFAULT_HAIL_MARY_CONFIG for any unset or invalid value.
 *
 * The feature is enabled by default: only an explicit "false" disables it, so
 * existing deployments keep their prior always-on behavior after upgrade.
 */
export async function loadHailMaryConfig(prisma: PrismaLike): Promise<HailMarySettings> {
  const enabledRaw = await readSetting(prisma, HAIL_MARY_SETTING_KEYS.enabled);
  const enabled = enabledRaw !== "false";

  const thresholdPct = parseFloat(
    (await readSetting(prisma, HAIL_MARY_SETTING_KEYS.remainingThreshold)) ?? "",
  );
  const windowHours = parseInt(
    (await readSetting(prisma, HAIL_MARY_SETTING_KEYS.windowHours)) ?? "",
    10,
  );
  const burstLimit = parseInt(
    (await readSetting(prisma, HAIL_MARY_SETTING_KEYS.defaultBurstLimit)) ?? "",
    10,
  );

  const config: HailMaryConfig = {
    remainingThreshold:
      !isNaN(thresholdPct) && thresholdPct >= 0 && thresholdPct <= 100
        ? thresholdPct / 100
        : DEFAULT_HAIL_MARY_CONFIG.remainingThreshold,
    windowHours:
      !isNaN(windowHours) && windowHours > 0
        ? windowHours
        : DEFAULT_HAIL_MARY_CONFIG.windowHours,
    defaultBurstLimitPerJob:
      !isNaN(burstLimit) && burstLimit > 0
        ? burstLimit
        : DEFAULT_HAIL_MARY_CONFIG.defaultBurstLimitPerJob,
  };

  return { enabled, config };
}

/**
 * Inspect each AI provider's cached health/usage data and trigger burst
 * sessions for any that meet the Hail Mary eligibility criteria.
 *
 * Safety guards:
 *   - Skips providers that are currently throttled (throttledUntil in the future)
 *   - Skips providers whose liveness status is not "ok"
 *   - Skips burst sessions already run for the current reset window
 *     (idempotent: keyed on resetsAt per provider)
 *
 * This function is designed to be called from the worker main loop and
 * executed as a fire-and-forget background task.
 */
export async function runHailMaryDetector(
  prisma: PrismaLike,
  configOverride?: HailMaryConfig,
): Promise<void> {
  // Global settings gate the entire feature. When no explicit override is
  // supplied (the worker's normal path), load the user's configured values.
  const settings = await loadHailMaryConfig(prisma);
  if (!settings.enabled) return;
  const config = configOverride ?? settings.config;

  const CACHE_KEY = "health_check_results";
  let cache: HealthCheckCache | null = null;

  try {
    const cacheRow = await prisma.setting.findUnique({ where: { key: CACHE_KEY } });
    if (cacheRow?.value) cache = JSON.parse(cacheRow.value) as HealthCheckCache;
  } catch {
    // If we can't read the cache, nothing to do
    return;
  }

  if (!cache || cache.results.length === 0) return;

  for (const healthStatus of cache.results as ProviderHealthStatus[]) {
    // Only CLI providers have OAuth usage metrics
    if (healthStatus.providerType !== "cli") continue;

    // Skip providers in error or unhealthy state
    if (!healthStatus.healthy || healthStatus.livenessStatus !== "ok") continue;

    // Skip providers without usage metrics
    if (!healthStatus.usageMetrics) continue;

    // Confirm against the DB that the provider is still usable — the cached health results
    // this loop iterates can outlive a provider being disabled or hitting a rate limit.
    try {
      const dbProvider = await prisma.aIProvider.findUnique({
        where: { id: healthStatus.providerId },
      });
      if (!isProviderUsable(dbProvider)) continue;
    } catch {
      continue;
    }

    const eligibility = checkHailMaryEligibility(healthStatus.usageMetrics, config);
    if (!eligibility.eligible) continue;

    // Idempotency: skip if we already ran a burst for this exact reset window
    const sessionKey = BURST_SESSION_KEY_PREFIX + healthStatus.providerId;
    try {
      const sessionRow = await prisma.setting.findUnique({ where: { key: sessionKey } });
      if (sessionRow?.value === eligibility.resetsAt) {
        // Already bursted for this reset window
        continue;
      }
    } catch {
      // Ignore; proceed with burst
    }

    // Mark this reset window as handled before running (prevent double-fire)
    try {
      await prisma.setting.upsert({
        where: { key: sessionKey },
        create: { key: sessionKey, value: eligibility.resetsAt },
        update: { value: eligibility.resetsAt },
      });
    } catch (err) {
      console.error("[HailMary] Failed to record burst session marker:", err);
    }

    // Run the burst (non-blocking: task records land in DB, worker picks them up)
    runProviderBurst(prisma, healthStatus.providerId, healthStatus.providerName, eligibility, config)
      .then((n) => {
        console.log(`[HailMary] Burst complete for "${healthStatus.providerName}": ${n} task(s) queued.`);
      })
      .catch((err) => {
        console.error(`[HailMary] Burst failed for "${healthStatus.providerName}":`, err);
      });
  }
}
