import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGatewayAnalytics, gatewayRowCost, type GatewayUsageRow } from "../gateway-analytics";

const row = (over: Partial<GatewayUsageRow>): GatewayUsageRow => ({
  createdAt: new Date(2026, 10, 14, 12, 30),
  apiKeyId: "k1",
  apiKeyName: "Cursor",
  format: "openai",
  providerName: "Claude API",
  providerType: "api",
  model: "claude-sonnet-5-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCost: null,
  errorType: null,
  durationMs: 1000,
  ...over,
});

test("empty input yields zero totals and fixed 24-bucket series", () => {
  const a = buildGatewayAnalytics([], new Date(2026, 10, 14, 12));
  assert.equal(a.totals.requests, 0);
  assert.equal(a.totals.avgDurationMs, null);
  assert.equal(a.totals.lastAt, null);
  assert.equal(a.last24h.length, 24);
  assert.equal(a.byHourOfDay.length, 24);
  assert.deepEqual(a.daily, []);
  assert.equal(a.last24h[23].label, "12:00");
  assert.equal(a.last24h[0].label, "13:00");
});

test("billed cost is used as-is for metered providers", () => {
  assert.deepEqual(gatewayRowCost(row({ estimatedCost: 0.25 })), { billed: 0.25, estimated: 0.25, atApiPricing: false });
});

test("subscription usage is priced at API rates, separately from billed cost", () => {
  const c = gatewayRowCost(row({ providerType: "cli", inputTokens: 1_000_000, outputTokens: 100_000 }));
  assert.equal(c.billed, 0);
  assert.equal(c.atApiPricing, true);
  assert.ok(Math.abs((c.estimated ?? 0) - 3) < 1e-9); // 1M × $2 + 0.1M × $10
});

test("unknown models stay unpriced", () => {
  const c = gatewayRowCost(row({ providerType: "cli", model: "mystery-model", inputTokens: 10 }));
  assert.equal(c.estimated, null);
  const a = buildGatewayAnalytics([row({ providerType: "codex-cli", model: null, inputTokens: 5 })]);
  assert.equal(a.totals.unpricedRequests, 1);
  assert.equal(a.totals.estimatedCost, 0);
});

test("totals, by-model and by-key aggregates", () => {
  const now = new Date(2026, 10, 14, 13);
  const a = buildGatewayAnalytics([
    row({ inputTokens: 100, outputTokens: 50, estimatedCost: 0.01, durationMs: 500, createdAt: new Date(2026, 10, 14, 9) }),
    row({ providerType: "cli", providerName: "Claude Max", inputTokens: 1_000_000, outputTokens: 0, durationMs: 1500, apiKeyId: "k2", apiKeyName: "Zed", createdAt: new Date(2026, 10, 14, 12, 5) }),
    row({ errorType: "rate_limit", inputTokens: 10, outputTokens: 0, cacheReadTokens: 7, createdAt: new Date(2026, 10, 13, 9), apiKeyName: "Cursor (old)" }),
  ], now);
  const t = a.totals;
  assert.equal(t.requests, 3);
  assert.equal(t.errors, 1);
  assert.equal(t.tokens, 1_000_160);
  assert.equal(t.cacheReadTokens, 7);
  assert.ok(Math.abs(t.billedCost - 0.01) < 1e-9);
  assert.ok(Math.abs(t.subscriptionEquivalentCost - 2) < 1e-9);
  assert.ok(Math.abs(t.estimatedCost - 2.01) < 1e-9);
  assert.equal(t.avgDurationMs, 1000);
  assert.deepEqual(t.lastAt, new Date(2026, 10, 14, 12, 5));
  assert.deepEqual(t.firstAt, new Date(2026, 10, 13, 9));

  assert.deepEqual(a.daily.map((d) => [d.label, d.requests]), [["11/13", 1], ["11/14", 2]]);
  assert.equal(a.byHourOfDay[9].requests, 2);
  assert.equal(a.byHourOfDay[12].requests, 1);

  assert.equal(a.byModel.length, 2);
  assert.equal(a.byModel[0].providerName, "Claude Max");
  assert.equal(a.byModel[0].atApiPricing, true);
  assert.equal(a.byModel[1].errors, 1);

  assert.equal(a.byApiKey[0].name, "Zed");
  const cursor = a.byApiKey.find((k) => k.apiKeyId === "k1")!;
  assert.equal(cursor.requests, 2);
  assert.equal(cursor.name, "Cursor"); // newest snapshot wins regardless of row order
  assert.deepEqual(cursor.lastUsedAt, new Date(2026, 10, 14, 9));
});

test("last 24h buckets only include rows within the window", () => {
  const now = new Date(2026, 10, 14, 13, 20);
  const a = buildGatewayAnalytics([
    row({ inputTokens: 1, createdAt: new Date(2026, 10, 14, 13, 5) }),  // current hour
    row({ inputTokens: 2, createdAt: new Date(2026, 10, 13, 14, 0) }),  // first bucket
    row({ inputTokens: 4, createdAt: new Date(2026, 10, 13, 13, 59) }), // just outside
  ], now);
  assert.equal(a.last24h[23].inputTokens, 1);
  assert.equal(a.last24h[0].inputTokens, 2);
  assert.equal(a.last24h.reduce((s, b) => s + b.requests, 0), 2);
});
