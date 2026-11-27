/**
 * Unit tests for provider health checks — specifically the rule that we never run
 * (or report a failure for) a liveness check when the subscription is out of tokens.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/health-check.test.ts
 */

import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  isUsageExhausted,
  usageResetTime,
  describeUsageExhaustion,
  detectUsageLimit,
  hasExtraUsageHeadroom,
  readCliExtraUsage,
  creditGateMayBeStale,
  checkProvider,
  type OAuthUsageMetrics,
  type OAuthExtraUsage,
} from "../health-check";

const HOUR = 60 * 60 * 1000;

function metrics(fiveHour: number, sevenDay: number, resetsInMs = HOUR): OAuthUsageMetrics {
  const resets_at = new Date(Date.now() + resetsInMs).toISOString();
  return {
    five_hour: { utilization: fiveHour, resets_at },
    seven_day: { utilization: sevenDay, resets_at },
  };
}

describe("isUsageExhausted", () => {
  it("is false when both windows have headroom", () => {
    assert.equal(isUsageExhausted(metrics(10, 42)), false);
    assert.equal(isUsageExhausted(metrics(99.9, 99.9)), false);
  });

  it("is true when either window is fully spent", () => {
    assert.equal(isUsageExhausted(metrics(100, 20)), true);
    assert.equal(isUsageExhausted(metrics(0, 100)), true);
    assert.equal(isUsageExhausted(metrics(140, 120)), true);
  });

  it("is false without metrics — we can't claim exhaustion we haven't confirmed", () => {
    assert.equal(isUsageExhausted(undefined), false);
  });

  it("ignores stale exhaustion whose reset time has already passed", () => {
    assert.equal(isUsageExhausted(metrics(100, 100, -HOUR)), false);
  });
});

describe("extra usage (usage credits)", () => {
  function withExtra(extra: OAuthExtraUsage, fiveHour = 100, sevenDay = 20): OAuthUsageMetrics {
    return { ...metrics(fiveHour, sevenDay), extra_usage: extra };
  }

  const active: OAuthExtraUsage = {
    is_enabled: true,
    monthly_limit: 2000,
    used_credits: 68,
    utilization: 3.4,
    currency: "USD",
    decimal_places: 2,
    user_disabled: false,
    spend_limit_reached: false,
    credits_ever_enabled: true,
  };

  it("treats a spent plan window as usable when credits are enabled with budget left", () => {
    assert.equal(hasExtraUsageHeadroom(withExtra(active)), true);
    assert.equal(isUsageExhausted(withExtra(active)), false);
  });

  it("still reports exhaustion when credits are off, disabled, or spent", () => {
    assert.equal(isUsageExhausted(withExtra({ ...active, is_enabled: false, user_disabled: true })), true);
    assert.equal(isUsageExhausted(withExtra({ ...active, spend_limit_reached: true })), true);
    assert.equal(isUsageExhausted(withExtra({ ...active, utilization: 100 })), true);
    assert.equal(isUsageExhausted(withExtra({ ...active, disabled_reason: "payment_failed" })), true);
  });

  it("ignores credits when no window is spent (nothing to cover)", () => {
    assert.equal(isUsageExhausted(withExtra(active, 40, 20)), false);
    assert.equal(isUsageExhausted(withExtra({ ...active, spend_limit_reached: true }, 40, 20)), false);
  });

  it("has no headroom without an extra_usage block at all", () => {
    assert.equal(hasExtraUsageHeadroom(metrics(100, 20)), false);
    assert.equal(hasExtraUsageHeadroom(undefined), false);
  });

  // The account can advertise credits the CLI refuses to spend — it stops at the plan limit
  // with "You've hit your session limit" and never bills a cent. The CLI's own gate wins.
  it("reports exhaustion when the CLI has credits blocked, whatever the account says", () => {
    assert.equal(hasExtraUsageHeadroom(withExtra(active), "blocked"), false);
    assert.equal(isUsageExhausted(withExtra(active), "blocked"), true);
  });

  it("keeps the account-level checks when the CLI says credits are usable", () => {
    assert.equal(isUsageExhausted(withExtra(active), "usable"), false);
    assert.equal(isUsageExhausted(withExtra({ ...active, spend_limit_reached: true }), "usable"), true);
  });

  it("a blocked CLI doesn't invent exhaustion out of a healthy window", () => {
    assert.equal(isUsageExhausted(withExtra(active, 40, 20), "blocked"), false);
  });

  // A cached gate we act on but never refresh would pin the provider in the blocked state for
  // good, so the disagreement has to be re-tested rather than trusted.
  it("flags an account/CLI disagreement as worth re-testing", () => {
    assert.equal(creditGateMayBeStale(withExtra(active), { state: "blocked", reason: "org_level_disabled" }), true);
    assert.equal(creditGateMayBeStale(withExtra(active), { state: "usable" }), false);
    assert.equal(creditGateMayBeStale(withExtra(active), { state: "unknown" }), false);
    // Nothing to re-test when the account itself says there are no credits to spend.
    assert.equal(creditGateMayBeStale(withExtra({ ...active, is_enabled: false }), { state: "blocked" }), false);
    assert.equal(creditGateMayBeStale(metrics(100, 20), { state: "blocked" }), false);
  });

  it("explains the account/CLI mismatch so it isn't a silent stall", () => {
    const message = describeUsageExhaustion(withExtra(active), { state: "blocked", reason: "org_level_disabled" });
    assert.match(message, /org_level_disabled/);
    assert.match(message, /will not spend/);
  });
});

describe("readCliExtraUsage", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "cli-config-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeConfig(value: unknown) {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ userID: "x", ...(value as object) }));
  }

  it("reads a null reason as credits the CLI will spend", () => {
    writeConfig({ cachedExtraUsageDisabledReason: null });
    assert.deepEqual(readCliExtraUsage(dir), { state: "usable" });
  });

  it("reads any reason as blocked, and keeps it for the message", () => {
    writeConfig({ cachedExtraUsageDisabledReason: "org_level_disabled" });
    assert.deepEqual(readCliExtraUsage(dir), { state: "blocked", reason: "org_level_disabled" });
  });

  it("is unknown when the CLI has never cached a reason", () => {
    writeConfig({});
    assert.equal(readCliExtraUsage(dir).state, "unknown");
  });

  it("is unknown for a missing or unreadable config", () => {
    assert.equal(readCliExtraUsage(join(dir, "nope")).state, "unknown");
  });
});

describe("usageResetTime", () => {
  it("returns null when nothing is exhausted", () => {
    assert.equal(usageResetTime(metrics(10, 42)), null);
    assert.equal(usageResetTime(undefined), null);
  });

  it("returns the exhausted window's reset time", () => {
    const m = metrics(100, 20, 2 * HOUR);
    const reset = usageResetTime(m);
    assert.ok(reset instanceof Date);
    assert.equal(reset?.toISOString(), m.five_hour.resets_at);
  });

  it("picks the soonest reset when both windows are exhausted", () => {
    const soonResets = new Date(Date.now() + HOUR).toISOString();
    const laterResets = new Date(Date.now() + 5 * HOUR).toISOString();
    const m: OAuthUsageMetrics = {
      five_hour: { utilization: 100, resets_at: soonResets },
      seven_day: { utilization: 100, resets_at: laterResets },
    };
    assert.equal(usageResetTime(m)?.toISOString(), soonResets);
  });

  it("ignores a stale (already-passed) reset time, same as isUsageExhausted", () => {
    assert.equal(usageResetTime(metrics(100, 100, -HOUR)), null);
  });
});

describe("describeUsageExhaustion", () => {
  it("names the window that ran out", () => {
    assert.match(describeUsageExhaustion(metrics(100, 30)), /5-hour/);
    assert.match(describeUsageExhaustion(metrics(30, 100)), /7-day/);
  });

  it("falls back to a generic message with no metrics", () => {
    assert.match(describeUsageExhaustion(undefined), /Usage limit reached/);
  });
});

describe("detectUsageLimit", () => {
  it("recognizes CLI and API rate/usage limit messages", () => {
    assert.ok(detectUsageLimit("Claude usage limit reached. Resets at 5pm"));
    assert.ok(detectUsageLimit("429 rate_limit_error"));
    assert.ok(detectUsageLimit("Your credit balance is too low to access the API"));
    assert.ok(detectUsageLimit("insufficient_quota"));
  });

  it("does not flag unrelated errors", () => {
    assert.equal(detectUsageLimit("ECONNREFUSED while contacting the API"), null);
    assert.equal(detectUsageLimit("Segmentation fault"), null);
  });
});

describe("checkProvider — CLI provider with no tokens left", () => {
  const originalFetch = globalThis.fetch;

  function stubUsage(payload: OAuthUsageMetrics) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
  }

  const provider = {
    id: "p1",
    name: "Subscription",
    type: "cli",
    isEnabled: true,
    configDir: null,
    credentialsJson: JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + HOUR } }),
    apiKey: null,
    baseUrl: null,
    model: null,
  };

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("skips the liveness check instead of reporting a failure", async () => {
    stubUsage(metrics(100, 80));

    const result = await checkProvider(provider);

    // The important bit: no "error" liveness status, so the UI never says "Liveness failed"
    assert.equal(result.livenessStatus, "skipped");
    assert.equal(result.usageExhausted, true);
    assert.equal(result.livenessError, undefined);
    assert.equal(result.livenessWarning, undefined);
    assert.equal(result.authStatus, "ok");
    assert.match(result.livenessSkipReason ?? "", /Usage limit reached/);
    assert.equal(result.usageMetrics?.five_hour.utilization, 100);
  });

  it("reports missing credentials as an auth problem, not a usage one", async () => {
    stubUsage(metrics(100, 80));

    const result = await checkProvider({ ...provider, credentialsJson: null, configDir: "/nonexistent-config-dir" });

    assert.equal(result.authStatus, "missing");
    assert.equal(result.livenessStatus, "skipped");
    assert.notEqual(result.usageExhausted, true);
  });
});

describe("checkProvider — CLI provider busy with a running task", () => {
  const originalFetch = globalThis.fetch;

  function stubUsage(payload: OAuthUsageMetrics) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
  }

  const provider = {
    id: "p1",
    name: "Subscription",
    type: "cli",
    isEnabled: true,
    configDir: null,
    credentialsJson: JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + HOUR } }),
    apiKey: null,
    baseUrl: null,
    model: null,
  };

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("skips the liveness probe instead of racing the running task's own token refresh", async () => {
    // Plenty of headroom, so this isn't a usage-exhaustion skip — it must be the busy skip.
    stubUsage(metrics(10, 20));

    const result = await checkProvider(provider, undefined, { busy: true });

    // Never spawns the competing `claude` CLI process, so it can never report the
    // misleading "Credentials have expired" auth error caused by a refresh-token race.
    assert.equal(result.livenessStatus, "skipped");
    assert.equal(result.authStatus, "ok");
    assert.equal(result.authError, undefined);
    assert.equal(result.healthy, true);
    assert.match(result.livenessSkipReason ?? "", /running/i);
  });
});
