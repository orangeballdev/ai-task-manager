/**
 * Unit tests for the per-provider usage cap (`AIProvider.maxUsagePercent`): a subscription
 * connection is held back once either plan window reaches the cap, so the remainder stays free
 * for the user's own manual use.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/usage-cap.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isOverUsageCap,
  isUsageExhausted,
  normalizeMaxUsagePercent,
  usageResetTime,
  type OAuthUsageMetrics,
} from "../health-check";
import {
  enforceUsageCap,
  evaluateUsageCap,
  hasEnforceableUsageCap,
  parseMaxUsagePercentInput,
} from "../usage-cap";
import { pickSmartProvider, type UsageLookup } from "../smart-provider";

const HOUR = 60 * 60 * 1000;

function usage(fiveHour: number, sevenDay: number, fiveResetMs = HOUR, sevenResetMs = 48 * HOUR): OAuthUsageMetrics {
  return {
    five_hour: { utilization: fiveHour, resets_at: new Date(Date.now() + fiveResetMs).toISOString() },
    seven_day: { utilization: sevenDay, resets_at: new Date(Date.now() + sevenResetMs).toISOString() },
  };
}

describe("normalizeMaxUsagePercent", () => {
  it("defaults anything missing or invalid to 100 (no cap)", () => {
    assert.equal(normalizeMaxUsagePercent(undefined), 100);
    assert.equal(normalizeMaxUsagePercent(null), 100);
    assert.equal(normalizeMaxUsagePercent("abc"), 100);
  });
  it("clamps to 1–100", () => {
    assert.equal(normalizeMaxUsagePercent(0), 1);
    assert.equal(normalizeMaxUsagePercent(250), 100);
    assert.equal(normalizeMaxUsagePercent(89.6), 90);
  });
});

describe("parseMaxUsagePercentInput", () => {
  it("accepts whole numbers 1–100 and rejects the rest", () => {
    assert.equal(parseMaxUsagePercentInput(undefined), undefined);
    assert.equal(parseMaxUsagePercentInput(90), 90);
    assert.equal(parseMaxUsagePercentInput("75"), 75);
    assert.equal(parseMaxUsagePercentInput(0), null);
    assert.equal(parseMaxUsagePercentInput(101), null);
    assert.equal(parseMaxUsagePercentInput(50.5), null);
    assert.equal(parseMaxUsagePercentInput(""), null);
    assert.equal(parseMaxUsagePercentInput(null), null);
  });
});

describe("isOverUsageCap", () => {
  it("never applies at the default of 100%", () => {
    assert.equal(isOverUsageCap(usage(99, 99), 100), false);
    assert.equal(isOverUsageCap(usage(100, 100)), false);
  });
  it("trips when either window reaches the cap", () => {
    assert.equal(isOverUsageCap(usage(89, 50), 90), false);
    assert.equal(isOverUsageCap(usage(90, 50), 90), true);
    assert.equal(isOverUsageCap(usage(10, 95), 90), true);
  });
  it("ignores a window whose reset time has already passed", () => {
    assert.equal(isOverUsageCap(usage(95, 10, -HOUR), 90), false);
  });
  it("makes isUsageExhausted true regardless of usage credits", () => {
    const withCredits: OAuthUsageMetrics = {
      ...usage(95, 10),
      extra_usage: { is_enabled: true, utilization: 0, user_disabled: false, spend_limit_reached: false },
    };
    assert.equal(isUsageExhausted(withCredits, "usable", 90), true);
    assert.equal(isUsageExhausted(withCredits, "usable"), false);
  });
});

describe("usageResetTime with a cap", () => {
  it("returns the capped window's reset", () => {
    const m = usage(95, 10);
    assert.equal(usageResetTime(m, 90)?.toISOString(), m.five_hour.resets_at);
  });
  it("waits for the later reset when both windows are over the cap", () => {
    const m = usage(95, 92);
    assert.equal(usageResetTime(m, 90)?.toISOString(), m.seven_day.resets_at);
  });
  it("is unchanged without a cap", () => {
    assert.equal(usageResetTime(usage(95, 92)), null);
  });
});

describe("evaluateUsageCap", () => {
  it("reports which window hit the cap and when it frees up", () => {
    const m = usage(10, 93);
    const verdict = evaluateUsageCap(m, 90);
    assert.ok(verdict);
    assert.equal(verdict.window, "7-day");
    assert.equal(verdict.usedPercent, 93);
    assert.equal(verdict.cap, 90);
    assert.equal(verdict.throttledUntil.toISOString(), m.seven_day.resets_at);
  });
  it("is null under the cap, with no cap, or with no figures", () => {
    assert.equal(evaluateUsageCap(usage(50, 50), 90), null);
    assert.equal(evaluateUsageCap(usage(99, 99), 100), null);
    assert.equal(evaluateUsageCap(null, 90), null);
  });
});

describe("enforceUsageCap", () => {
  function client(updates: unknown[]) {
    return { aIProvider: { update: async (args: unknown) => { updates.push(args); return {}; } } };
  }
  const base = { id: "p1", name: "Sub", type: "cli", maxUsagePercent: 90 };

  it("throttles an over-cap subscription until its window resets", async () => {
    const updates: { where: { id: string }; data: { throttledUntil: Date } }[] = [];
    const m = usage(91, 20);
    const result = await enforceUsageCap(base, client(updates), new Date(), async () => m);
    assert.ok(result);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].where.id, "p1");
    assert.equal(updates[0].data.throttledUntil.toISOString(), m.five_hour.resets_at);
  });

  it("leaves providers alone when under the cap, uncapped, metered, or usage is unknown", async () => {
    const updates: unknown[] = [];
    let lookups = 0;
    const lookup = async () => { lookups++; return usage(95, 95); };
    assert.equal(await enforceUsageCap({ ...base, maxUsagePercent: 100 }, client(updates), new Date(), lookup), null);
    assert.equal(await enforceUsageCap({ ...base, type: "api" }, client(updates), new Date(), lookup), null);
    assert.equal(lookups, 0, "no lookup when there's nothing to enforce");
    assert.equal(await enforceUsageCap(base, client(updates), new Date(), async () => usage(50, 50)), null);
    assert.equal(await enforceUsageCap(base, client(updates), new Date(), async () => null), null);
    assert.equal(await enforceUsageCap(base, client(updates), new Date(), async () => { throw new Error("down"); }), null);
    assert.deepEqual(updates, []);
  });

  it("applies to Codex connections too", () => {
    assert.equal(hasEnforceableUsageCap({ type: "codex-cli", maxUsagePercent: 80 }), true);
    assert.equal(hasEnforceableUsageCap({ type: "openai", maxUsagePercent: 80 }), false);
  });
});

describe("pickSmartProvider with usage caps", () => {
  const providers = [
    { id: "capped", name: "Capped", type: "cli", isEnabled: true, maxUsagePercent: 90, createdAt: new Date(0) },
    { id: "free", name: "Free", type: "cli", isEnabled: true, maxUsagePercent: 100, createdAt: new Date(1) },
  ];
  const stub = { aIProvider: { findMany: async () => providers } };

  it("skips a subscription that has reached its cap, even if it renews soonest", async () => {
    const lookup: UsageLookup = async (p) => (p.id === "capped" ? usage(92, 50, HOUR, 24 * HOUR) : usage(10, 10, HOUR, 96 * HOUR));
    assert.equal(await pickSmartProvider(stub, new Date(), { usageLookup: lookup }), "free");
  });

  it("still picks it while it's under the cap", async () => {
    const lookup: UsageLookup = async (p) => (p.id === "capped" ? usage(80, 50, HOUR, 24 * HOUR) : usage(10, 10, HOUR, 96 * HOUR));
    assert.equal(await pickSmartProvider(stub, new Date(), { usageLookup: lookup }), "capped");
  });
});
