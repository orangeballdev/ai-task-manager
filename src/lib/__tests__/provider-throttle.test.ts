/**
 * Unit tests for re-validating a provider's recorded throttle.
 *
 * The rule under test: `throttledUntil` is a cached verdict, and we never park work on it
 * without confirming it's still true — but we also never clear it on no evidence.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/provider-throttle.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  revalidateProviderThrottle,
  resetThrottleRevalidationCache,
  type ThrottledProviderShape,
} from "../provider-throttle";
import type { OAuthUsageMetrics, OAuthExtraUsage } from "../health-check";

const HOUR = 60 * 60 * 1000;
const originalFetch = globalThis.fetch;

let configDir: string;
let updates: { id: string; throttledUntil: Date | null }[];
let fetchCount: number;

function client() {
  return {
    aIProvider: {
      update: async ({ where, data }: { where: { id: string }; data: { throttledUntil: Date | null } }) => {
        updates.push({ id: where.id, throttledUntil: data.throttledUntil });
        return {};
      },
    },
  };
}

function stubUsage(payload: OAuthUsageMetrics | null, status = 200) {
  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response(payload ? JSON.stringify(payload) : "", {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function usage(fiveHour: number, sevenDay: number, extra?: OAuthExtraUsage): OAuthUsageMetrics {
  const resets_at = new Date(Date.now() + HOUR).toISOString();
  return {
    five_hour: { utilization: fiveHour, resets_at },
    seven_day: { utilization: sevenDay, resets_at },
    ...(extra ? { extra_usage: extra } : {}),
  };
}

function writeCliConfig(reason: string | null | undefined) {
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify(reason === undefined ? {} : { cachedExtraUsageDisabledReason: reason }),
  );
}

function provider(overrides: Partial<ThrottledProviderShape> = {}): ThrottledProviderShape {
  return {
    id: "p1",
    name: "Subscription",
    type: "cli",
    configDir,
    credentialsJson: JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + HOUR } }),
    throttledUntil: new Date(Date.now() + 3 * HOUR),
    ...overrides,
  };
}

describe("revalidateProviderThrottle", () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "throttle-test-"));
    writeCliConfig(undefined);
    updates = [];
    fetchCount = 0;
    resetThrottleRevalidationCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("is a no-op for a provider that isn't throttled", async () => {
    stubUsage(usage(10, 10));
    assert.equal(await revalidateProviderThrottle(provider({ throttledUntil: null }), client()), false);
    assert.equal(await revalidateProviderThrottle(null, client()), false);
    assert.equal(fetchCount, 0);
    assert.deepEqual(updates, []);
  });

  it("treats an already-expired throttle as gone without asking the API", async () => {
    stubUsage(usage(10, 10));
    const result = await revalidateProviderThrottle(provider({ throttledUntil: new Date(Date.now() - HOUR) }), client());
    assert.equal(result, false);
    assert.equal(fetchCount, 0);
  });

  it("clears the throttle when the usage window has actually recovered", async () => {
    stubUsage(usage(12, 40));
    assert.equal(await revalidateProviderThrottle(provider(), client()), false);
    assert.deepEqual(updates, [{ id: "p1", throttledUntil: null }]);
  });

  it("keeps the throttle while the window is genuinely spent", async () => {
    stubUsage(usage(100, 40));
    assert.equal(await revalidateProviderThrottle(provider(), client()), true);
    // Re-pointed at the reset time the API reports now, rather than cleared.
    assert.equal(updates.length, 1);
    assert.ok(updates[0].throttledUntil instanceof Date);
  });

  it("keeps the throttle while a window is still over the provider's usage cap", async () => {
    stubUsage(usage(92, 40));
    assert.equal(await revalidateProviderThrottle(provider({ maxUsagePercent: 90 }), client()), true);
    assert.equal(updates.length, 1);
    assert.ok(updates[0].throttledUntil instanceof Date);
  });

  it("keeps a cap throttle even when usage credits are available", async () => {
    writeCliConfig(null);
    stubUsage(usage(95, 40, { is_enabled: true, utilization: 5, user_disabled: false, spend_limit_reached: false }));
    assert.equal(await revalidateProviderThrottle(provider({ maxUsagePercent: 90 }), client()), true);
  });

  it("clears the throttle once usage drops back under the cap", async () => {
    stubUsage(usage(85, 40));
    assert.equal(await revalidateProviderThrottle(provider({ maxUsagePercent: 90 }), client()), false);
    assert.deepEqual(updates, [{ id: "p1", throttledUntil: null }]);
  });

  it("clears the throttle when usage credits are covering a spent window", async () => {
    writeCliConfig(null); // CLI will spend credits
    stubUsage(usage(100, 40, { is_enabled: true, utilization: 5, user_disabled: false, spend_limit_reached: false }));
    assert.equal(await revalidateProviderThrottle(provider(), client()), false);
    assert.deepEqual(updates, [{ id: "p1", throttledUntil: null }]);
  });

  // The regression this whole change exists for: credits look enabled on the account, but the
  // CLI has them gated, so releasing the task would only produce another session-limit failure.
  // The CLI's gate is a cache it only refreshes by making a request, so this is settled with a
  // probe rather than by trusting either side.
  const disagreement = {
    is_enabled: true, utilization: 0, user_disabled: false, spend_limit_reached: false,
  } satisfies OAuthExtraUsage;

  it("keeps the throttle when the probe confirms the CLI still won't run", async () => {
    writeCliConfig("org_level_disabled");
    stubUsage(usage(100, 40, disagreement));
    const probe = async () => ({ ok: false, limitMessage: "You've hit your session limit" });
    assert.equal(await revalidateProviderThrottle(provider(), client(), new Date(), probe), true);
    assert.equal(updates.some((u) => u.throttledUntil === null), false);
  });

  it("clears the throttle when the probe shows the CLI's cached block is stale", async () => {
    writeCliConfig("org_level_disabled");
    stubUsage(usage(100, 40, disagreement));
    const probe = async () => ({ ok: true });
    assert.equal(await revalidateProviderThrottle(provider(), client(), new Date(), probe), false);
    assert.deepEqual(updates, [{ id: "p1", throttledUntil: null }]);
  });

  it("doesn't probe when the account itself says there are no credits", async () => {
    writeCliConfig("org_level_disabled");
    stubUsage(usage(100, 40, { ...disagreement, is_enabled: false }));
    let probed = false;
    const probe = async () => { probed = true; return { ok: true }; };
    assert.equal(await revalidateProviderThrottle(provider(), client(), new Date(), probe), true);
    assert.equal(probed, false);
  });

  it("keeps the throttle when the usage API gives us nothing to go on", async () => {
    stubUsage(null, 429);
    assert.equal(await revalidateProviderThrottle(provider(), client()), true);
    assert.deepEqual(updates, []);
  });

  it("keeps the throttle when there are no credentials to check with", async () => {
    stubUsage(usage(10, 10));
    const result = await revalidateProviderThrottle(
      provider({ credentialsJson: null, configDir: join(configDir, "empty") }),
      client(),
    );
    assert.equal(result, true);
    assert.equal(fetchCount, 0);
  });

  it("leaves non-CLI providers alone — their throttle can't be re-tested cheaply", async () => {
    stubUsage(usage(10, 10));
    assert.equal(await revalidateProviderThrottle(provider({ type: "api" }), client()), true);
    assert.equal(fetchCount, 0);
  });

  it("doesn't re-ask the API for every parked task in the same poll", async () => {
    stubUsage(usage(100, 40));
    await revalidateProviderThrottle(provider(), client());
    await revalidateProviderThrottle(provider(), client());
    await revalidateProviderThrottle(provider(), client());
    assert.equal(fetchCount, 1);
  });
});
