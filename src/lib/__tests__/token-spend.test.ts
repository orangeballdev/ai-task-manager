import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTokenSpendBreakdown, type GatewaySpendRow } from "../token-spend";

const gw = (over: Partial<GatewaySpendRow>): GatewaySpendRow => ({
  createdAt: new Date(2026, 10, 14, 12),
  apiKeyId: "k1",
  apiKeyName: "Cursor",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCost: null,
  errorType: null,
  ...over,
});

test("empty input yields zeroed sources and no shares", () => {
  const b = buildTokenSpendBreakdown([], []);
  assert.equal(b.totalTokens, 0);
  assert.equal(b.sources[0].share, 0);
  assert.equal(b.sources[1].share, 0);
  assert.deepEqual(b.daily, []);
  assert.deepEqual(b.byApiKey, []);
});

test("splits tokens and cost between tasks and the gateway", () => {
  const b = buildTokenSpendBreakdown(
    [
      { createdAt: new Date(2026, 10, 14, 9), inputTokens: 600, outputTokens: 150, estimatedCost: 0.5 },
      { createdAt: new Date(2026, 10, 14, 10), inputTokens: null, outputTokens: null, estimatedCost: null },
    ],
    [gw({ inputTokens: 200, outputTokens: 50, estimatedCost: 0.25, cacheReadTokens: 1000 })],
  );
  const [tasks, gateway] = b.sources;
  assert.equal(tasks.count, 2);
  assert.equal(tasks.tokens, 750);
  assert.equal(gateway.count, 1);
  assert.equal(gateway.tokens, 250);
  assert.equal(b.totalTokens, 1000);
  assert.equal(tasks.share, 0.75);
  assert.equal(gateway.share, 0.25);
  assert.equal(b.totalCost, 0.75);
  // Cache tokens are reported separately, not counted in the split.
  assert.equal(b.gatewayCacheReadTokens, 1000);
});

test("daily rows merge both sources per local day, sorted across a year boundary", () => {
  const b = buildTokenSpendBreakdown(
    [{ createdAt: new Date(2027, 0, 2, 8), inputTokens: 10, outputTokens: 0, estimatedCost: null }],
    [
      gw({ createdAt: new Date(2026, 11, 31, 8), inputTokens: 5, outputTokens: 5 }),
      gw({ createdAt: new Date(2027, 0, 2, 20), inputTokens: 1, outputTokens: 1 }),
    ],
  );
  assert.deepEqual(b.daily.map((d) => [d.day, d.date, d.tasks, d.gateway]), [
    ["2026-12-31", "12/31", 0, 10],
    ["2027-01-02", "01/02", 10, 2],
  ]);
});

test("groups gateway usage by API key, counting errors, biggest spender first", () => {
  const b = buildTokenSpendBreakdown([], [
    gw({ apiKeyId: "k1", apiKeyName: "Old name", inputTokens: 10, outputTokens: 0 }),
    gw({ apiKeyId: "k2", apiKeyName: "Aider", inputTokens: 500, outputTokens: 100, errorType: "timeout" }),
    gw({ apiKeyId: "k1", apiKeyName: "Cursor", inputTokens: 20, outputTokens: 5, cacheCreationTokens: 7 }),
  ]);
  assert.deepEqual(b.byApiKey.map((k) => [k.apiKeyId, k.name, k.requests, k.errors, k.tokens]), [
    ["k2", "Aider", 1, 1, 600],
    ["k1", "Cursor", 2, 0, 35],
  ]);
  assert.equal(b.byApiKey[1].cacheCreationTokens, 7);
});
