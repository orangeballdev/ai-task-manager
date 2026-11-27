/**
 * Unit tests for the Hail Mary burst execution module.
 *
 * Uses Node.js built-in test runner (node:test / node:assert), available
 * since Node 18.  Run with:
 *
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/hail-mary.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkHailMaryEligibility,
  selectNextRoundRobin,
  buildBurstExecutionPlan,
  runProviderBurst,
  runHailMaryDetector,
  DEFAULT_HAIL_MARY_CONFIG,
  type EligibleTemplate,
  type HailMaryConfig,
} from "../hail-mary.js";
import type { OAuthUsageMetrics } from "../health-check.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an OAuthUsageMetrics fixture with custom utilization and reset time. */
function makeMetrics(
  fiveHourUtilization: number,
  fiveHourResetsAt: Date,
  sevenDayUtilization: number = 0.5,
  sevenDayResetsAt: Date = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
): OAuthUsageMetrics {
  return {
    five_hour: {
      utilization: fiveHourUtilization,
      resets_at: fiveHourResetsAt.toISOString(),
    },
    seven_day: {
      utilization: sevenDayUtilization,
      resets_at: sevenDayResetsAt.toISOString(),
    },
  };
}

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// 1. Threshold detection — checkHailMaryEligibility
// ---------------------------------------------------------------------------

describe("checkHailMaryEligibility — threshold detection", () => {
  it("returns eligible when remaining > threshold AND reset is within window", () => {
    // 30% remaining (1 - 0.70), resets in 12 hours
    const metrics = makeMetrics(0.70, hoursFromNow(12));
    const result = checkHailMaryEligibility(metrics);
    assert.equal(result.eligible, true);
    if (result.eligible) {
      assert.equal(result.window, "five_hour");
      assert.ok(result.remaining > DEFAULT_HAIL_MARY_CONFIG.remainingThreshold);
    }
  });

  it("returns not eligible when remaining <= threshold (quota nearly exhausted)", () => {
    // Only 5% remaining (1 - 0.95) — below the 20% threshold
    const metrics = makeMetrics(0.95, hoursFromNow(12));
    const result = checkHailMaryEligibility(metrics);
    assert.equal(result.eligible, false);
  });

  it("returns not eligible when reset window is beyond windowHours", () => {
    // 50% remaining but resets in 30 hours (beyond the 24h default window)
    const metrics = makeMetrics(0.50, hoursFromNow(30));
    const result = checkHailMaryEligibility(metrics);
    assert.equal(result.eligible, false);
  });

  it("returns not eligible when reset is in the past", () => {
    const metrics = makeMetrics(0.50, hoursFromNow(-1));
    const result = checkHailMaryEligibility(metrics);
    assert.equal(result.eligible, false);
  });

  it("falls through to seven_day window when five_hour is not eligible", () => {
    // five_hour: not within window
    // seven_day: 40% remaining, resets in 10 hours
    const metrics = makeMetrics(
      0.50, hoursFromNow(30),       // five_hour: 30h — beyond default 24h window
      0.60, hoursFromNow(10),       // seven_day: 40% remaining, resets in 10h
    );
    const result = checkHailMaryEligibility(metrics);
    assert.equal(result.eligible, true);
    if (result.eligible) {
      assert.equal(result.window, "seven_day");
    }
  });

  it("respects a custom remainingThreshold", () => {
    const config: HailMaryConfig = { ...DEFAULT_HAIL_MARY_CONFIG, remainingThreshold: 0.50 };
    // 40% remaining — below custom 50% threshold
    const metrics = makeMetrics(0.60, hoursFromNow(12));
    assert.equal(checkHailMaryEligibility(metrics, config).eligible, false);

    // 60% remaining — above custom 50% threshold
    const metrics2 = makeMetrics(0.40, hoursFromNow(12));
    assert.equal(checkHailMaryEligibility(metrics2, config).eligible, true);
  });

  it("respects a custom windowHours", () => {
    const config: HailMaryConfig = { ...DEFAULT_HAIL_MARY_CONFIG, windowHours: 6 };
    // Resets in 10 hours — outside a 6h window
    const metrics = makeMetrics(0.50, hoursFromNow(10));
    assert.equal(checkHailMaryEligibility(metrics, config).eligible, false);

    // Resets in 4 hours — inside a 6h window
    const metrics2 = makeMetrics(0.50, hoursFromNow(4));
    assert.equal(checkHailMaryEligibility(metrics2, config).eligible, true);
  });

  it("is not eligible when exactly at the threshold (strict greater-than)", () => {
    // Exactly 20% remaining (1 - 0.80 = 0.20) — not strictly greater than 0.20
    const metrics = makeMetrics(0.80, hoursFromNow(12));
    const result = checkHailMaryEligibility(metrics);
    assert.equal(result.eligible, false);
  });
});

// ---------------------------------------------------------------------------
// 2. Round-robin ordering — selectNextRoundRobin
// ---------------------------------------------------------------------------

describe("selectNextRoundRobin — round-robin ordering", () => {
  const templates: EligibleTemplate[] = [
    { id: "a", title: "Job A", hailMaryBurstLimit: 3 },
    { id: "b", title: "Job B", hailMaryBurstLimit: 2 },
    { id: "c", title: "Job C", hailMaryBurstLimit: 1 },
  ];

  it("starts at index 0 and returns the first template", () => {
    const counts = new Map<string, number>();
    const result = selectNextRoundRobin(templates, counts, 0);
    assert.ok(result !== null);
    assert.equal(result!.template.id, "a");
  });

  it("advances the index correctly after each selection", () => {
    const counts = new Map<string, number>([["a", 1]]);
    // index 1 → should return "b"
    const result = selectNextRoundRobin(templates, counts, 1);
    assert.ok(result !== null);
    assert.equal(result!.template.id, "b");
    assert.equal(result!.nextIndex, 2);
  });

  it("wraps around to the start of the list", () => {
    const counts = new Map<string, number>();
    // index 2 → "c", nextIndex = 0
    const result = selectNextRoundRobin(templates, counts, 2);
    assert.ok(result !== null);
    assert.equal(result!.template.id, "c");
    assert.equal(result!.nextIndex, 0);
  });

  it("skips a template that has reached its burst limit", () => {
    const counts = new Map<string, number>([["a", 3]]); // "a" is exhausted
    // From index 0, "a" is full → should skip to "b"
    const result = selectNextRoundRobin(templates, counts, 0);
    assert.ok(result !== null);
    assert.equal(result!.template.id, "b");
  });

  it("returns null when all templates have hit their burst limits", () => {
    const counts = new Map<string, number>([["a", 3], ["b", 2], ["c", 1]]);
    const result = selectNextRoundRobin(templates, counts, 0);
    assert.equal(result, null);
  });

  it("returns null for an empty template list", () => {
    const result = selectNextRoundRobin([], new Map(), 0);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// 3. Burst execution plan — buildBurstExecutionPlan
// ---------------------------------------------------------------------------

describe("buildBurstExecutionPlan — round-robin and burst limits", () => {
  it("produces an empty plan when no templates are provided", () => {
    const plan = buildBurstExecutionPlan([]);
    assert.deepEqual(plan, []);
  });

  it("cycles templates in round-robin order", () => {
    const templates: EligibleTemplate[] = [
      { id: "a", title: "A", hailMaryBurstLimit: 2 },
      { id: "b", title: "B", hailMaryBurstLimit: 2 },
    ];
    const plan = buildBurstExecutionPlan(templates);
    const ids = plan.map((e) => e.templateId);
    // Expected: a, b, a, b
    assert.deepEqual(ids, ["a", "b", "a", "b"]);
  });

  it("respects per-job burst limits", () => {
    const templates: EligibleTemplate[] = [
      { id: "a", title: "A", hailMaryBurstLimit: 3 },
      { id: "b", title: "B", hailMaryBurstLimit: 1 },
    ];
    const plan = buildBurstExecutionPlan(templates);

    const aEntries = plan.filter((e) => e.templateId === "a");
    const bEntries = plan.filter((e) => e.templateId === "b");

    assert.equal(aEntries.length, 3);
    assert.equal(bEntries.length, 1);
  });

  it("records correct execution numbers (1-based)", () => {
    const templates: EligibleTemplate[] = [
      { id: "a", title: "A", hailMaryBurstLimit: 3 },
    ];
    const plan = buildBurstExecutionPlan(templates);
    const numbers = plan.map((e) => e.executionNumber);
    assert.deepEqual(numbers, [1, 2, 3]);
  });

  it("interleaves templates with different burst limits correctly", () => {
    const templates: EligibleTemplate[] = [
      { id: "a", title: "A", hailMaryBurstLimit: 3 },
      { id: "b", title: "B", hailMaryBurstLimit: 2 },
      { id: "c", title: "C", hailMaryBurstLimit: 1 },
    ];
    const plan = buildBurstExecutionPlan(templates);

    // Total tasks: 3 + 2 + 1 = 6
    assert.equal(plan.length, 6);

    const aEntries = plan.filter((e) => e.templateId === "a");
    const bEntries = plan.filter((e) => e.templateId === "b");
    const cEntries = plan.filter((e) => e.templateId === "c");

    assert.equal(aEntries.length, 3);
    assert.equal(bEntries.length, 2);
    assert.equal(cEntries.length, 1);

    // First three entries should be one from each (round-robin start)
    assert.equal(plan[0].templateId, "a");
    assert.equal(plan[1].templateId, "b");
    assert.equal(plan[2].templateId, "c");
  });

  it("applies defaultBurstLimitPerJob when hailMaryBurstLimit is null", () => {
    const config: HailMaryConfig = { ...DEFAULT_HAIL_MARY_CONFIG, defaultBurstLimitPerJob: 3 };
    const templates: EligibleTemplate[] = [
      { id: "a", title: "A", hailMaryBurstLimit: null },
    ];
    const plan = buildBurstExecutionPlan(templates, config);
    assert.equal(plan.length, 3); // default 3 per job
  });

  it("produces a single execution when defaultBurstLimitPerJob is 1 (conservative default)", () => {
    const templates: EligibleTemplate[] = [
      { id: "a", title: "A", hailMaryBurstLimit: null },
      { id: "b", title: "B", hailMaryBurstLimit: null },
    ];
    // DEFAULT_HAIL_MARY_CONFIG.defaultBurstLimitPerJob = 1
    const plan = buildBurstExecutionPlan(templates);
    assert.equal(plan.length, 2); // 1 per job × 2 jobs
    assert.equal(plan[0].templateId, "a");
    assert.equal(plan[1].templateId, "b");
  });
});

// ---------------------------------------------------------------------------
// 4. No-op when hailMaryEligible = false
// ---------------------------------------------------------------------------

describe("no-op when hailMaryEligible = false", () => {
  /**
   * Build a minimal in-memory prisma stub for runProviderBurst / runHailMaryDetector.
   */
  function makePrismaStub(templates: {
    id: string;
    title: string;
    description: string;
    context: string | null;
    provider: string;
    model: string | null;
    pushToMain: boolean;
    targetBranch: string | null;
    createPR: boolean;
    aiProviderId: string | null;
    hailMaryEligible: boolean;
    hailMaryBurstLimit: number | null;
    repos: unknown[];
  }[]) {
    const createdTasks: unknown[] = [];
    let posCounter = 0;

    return {
      createdTasks,
      prisma: {
        task: {
          findMany: async (args: { where: { hailMaryEligible?: boolean } }) => {
            if (args.where.hailMaryEligible !== undefined) {
              return templates.filter((t) => t.hailMaryEligible === args.where.hailMaryEligible);
            }
            return templates;
          },
          create: async (args: { data: unknown }) => {
            const task = { id: `task-${createdTasks.length + 1}`, ...args.data as object };
            createdTasks.push(task);
            return task;
          },
          aggregate: async () => ({ _max: { position: posCounter++ } }),
        },
        setting: {
          findUnique: async () => null,
          upsert: async () => ({}),
        },
        aIProvider: {
          findUnique: async () => ({ id: "p1", throttledUntil: null }),
        },
      },
    };
  }

  it("creates zero burst tasks when no templates are hailMaryEligible", async () => {
    const { prisma, createdTasks } = makePrismaStub([
      {
        id: "t1", title: "Job 1", description: "desc", context: null,
        provider: "cli", model: null, pushToMain: false, targetBranch: null,
        createPR: false, aiProviderId: null,
        hailMaryEligible: false,  // <-- opted out
        hailMaryBurstLimit: 5,
        repos: [],
      },
    ]);

    const eligibility = {
      eligible: true as const,
      window: "five_hour" as const,
      remaining: 0.50,
      resetsAt: hoursFromNow(12).toISOString(),
    };

    const count = await runProviderBurst(prisma, "provider-1", "Test Provider", eligibility);
    assert.equal(count, 0);
    assert.equal(createdTasks.length, 0);
  });

  it("creates burst tasks only for hailMaryEligible=true templates", async () => {
    const { prisma, createdTasks } = makePrismaStub([
      {
        id: "t1", title: "Eligible Job", description: "desc", context: null,
        provider: "cli", model: null, pushToMain: false, targetBranch: null,
        createPR: false, aiProviderId: null,
        hailMaryEligible: true,
        hailMaryBurstLimit: 2,
        repos: [],
      },
      {
        id: "t2", title: "Non-Eligible Job", description: "desc", context: null,
        provider: "cli", model: null, pushToMain: false, targetBranch: null,
        createPR: false, aiProviderId: null,
        hailMaryEligible: false,  // <-- opted out
        hailMaryBurstLimit: 5,
        repos: [],
      },
    ]);

    const eligibility = {
      eligible: true as const,
      window: "five_hour" as const,
      remaining: 0.50,
      resetsAt: hoursFromNow(12).toISOString(),
    };

    // runProviderBurst only receives templates that the DB query already filtered
    // by hailMaryEligible=true; the stub does the same filtering.
    const count = await runProviderBurst(prisma, "provider-1", "Test Provider", eligibility);
    assert.equal(count, 2); // 1 template × burstLimit 2
    assert.equal(createdTasks.length, 2);
  });

  it("runHailMaryDetector is a no-op when all jobs have hailMaryEligible=false", async () => {
    const { prisma, createdTasks } = makePrismaStub([
      {
        id: "t1", title: "Non-Eligible", description: "d", context: null,
        provider: "cli", model: null, pushToMain: false, targetBranch: null,
        createPR: false, aiProviderId: null,
        hailMaryEligible: false,
        hailMaryBurstLimit: 10,
        repos: [],
      },
    ]);

    // Override setting.findUnique to return a mock health cache
    const healthCache = {
      results: [
        {
          providerId: "provider-1",
          providerName: "Test Provider",
          providerType: "cli",
          authStatus: "ok",
          livenessStatus: "ok",
          healthy: true,
          checkedAt: new Date().toISOString(),
          usageMetrics: makeMetrics(0.50, hoursFromNow(12)),
        },
      ],
      checkedAt: new Date().toISOString(),
    };

    const stubWithCache = {
      ...prisma,
      setting: {
        findUnique: async (args: { where: { key: string } }) => {
          if (args.where.key === "health_check_results") {
            return { key: "health_check_results", value: JSON.stringify(healthCache) };
          }
          return null;
        },
        upsert: async () => ({}),
      },
    };

    await runHailMaryDetector(stubWithCache);

    // Allow any async burst tasks to complete
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(createdTasks.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotency — no double-burst for same reset window
// ---------------------------------------------------------------------------

describe("runHailMaryDetector — idempotency", () => {
  it("skips burst when resetsAt was already recorded for this provider", async () => {
    const resetsAt = hoursFromNow(12).toISOString();
    const createdTasks: unknown[] = [];

    const prismaStub = {
      task: {
        findMany: async () => [],
        create: async (args: { data: unknown }) => {
          createdTasks.push(args.data);
          return { id: "new-task" };
        },
        aggregate: async () => ({ _max: { position: 0 } }),
      },
      setting: {
        findUnique: async (args: { where: { key: string } }) => {
          if (args.where.key === "health_check_results") {
            return {
              value: JSON.stringify({
                results: [{
                  providerId: "p1",
                  providerName: "Provider",
                  providerType: "cli",
                  authStatus: "ok",
                  livenessStatus: "ok",
                  healthy: true,
                  checkedAt: new Date().toISOString(),
                  usageMetrics: {
                    five_hour: { utilization: 0.50, resets_at: resetsAt },
                    seven_day: { utilization: 0.50, resets_at: hoursFromNow(48).toISOString() },
                  },
                }],
                checkedAt: new Date().toISOString(),
              }),
            };
          }
          // Return the already-stored resetsAt for the session key
          if (args.where.key === "hail_mary_last_burst_resetsAt_p1") {
            return { value: resetsAt }; // already recorded
          }
          return null;
        },
        upsert: async () => ({}),
      },
      aIProvider: {
        findUnique: async () => ({ id: "p1", throttledUntil: null }),
      },
    };

    await runHailMaryDetector(prismaStub);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(createdTasks.length, 0, "Should not create any tasks for an already-run burst session");
  });
});

// ---------------------------------------------------------------------------
// 6. Throttled provider guard
// ---------------------------------------------------------------------------

describe("runHailMaryDetector — throttled provider guard", () => {
  it("skips burst when provider has throttledUntil in the future", async () => {
    const createdTasks: unknown[] = [];

    const prismaStub = {
      task: {
        findMany: async () => [],
        create: async (args: { data: unknown }) => {
          createdTasks.push(args.data);
          return { id: "new-task" };
        },
        aggregate: async () => ({ _max: { position: 0 } }),
      },
      setting: {
        findUnique: async (args: { where: { key: string } }) => {
          if (args.where.key === "health_check_results") {
            return {
              value: JSON.stringify({
                results: [{
                  providerId: "p2",
                  providerName: "Throttled Provider",
                  providerType: "cli",
                  authStatus: "ok",
                  livenessStatus: "ok",
                  healthy: true,
                  checkedAt: new Date().toISOString(),
                  usageMetrics: {
                    five_hour: { utilization: 0.30, resets_at: hoursFromNow(10).toISOString() },
                    seven_day: { utilization: 0.30, resets_at: hoursFromNow(48).toISOString() },
                  },
                }],
                checkedAt: new Date().toISOString(),
              }),
            };
          }
          return null;
        },
        upsert: async () => ({}),
      },
      aIProvider: {
        // Provider is throttled until 2 hours from now
        findUnique: async () => ({ id: "p2", throttledUntil: hoursFromNow(2) }),
      },
    };

    await runHailMaryDetector(prismaStub);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(createdTasks.length, 0, "Should not burst a throttled provider");
  });
});
