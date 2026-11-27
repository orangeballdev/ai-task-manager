import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMaxRuns, hasReachedRunLimit, runsRemaining, formatRunUsage, MAX_RUNS_LIMIT } from "../max-runs";

test("normalizeMaxRuns treats missing/blank input as unlimited", () => {
  assert.equal(normalizeMaxRuns(undefined), null);
  assert.equal(normalizeMaxRuns(null), null);
  assert.equal(normalizeMaxRuns(""), null);
  assert.equal(normalizeMaxRuns("   "), null);
});

test("normalizeMaxRuns accepts positive integers from numbers and strings", () => {
  assert.equal(normalizeMaxRuns(5), 5);
  assert.equal(normalizeMaxRuns("5"), 5);
  assert.equal(normalizeMaxRuns(" 12 "), 12);
  assert.equal(normalizeMaxRuns(3.7), 3);
});

test("normalizeMaxRuns rejects zero, negatives and garbage (unlimited)", () => {
  assert.equal(normalizeMaxRuns(0), null);
  assert.equal(normalizeMaxRuns(-4), null);
  assert.equal(normalizeMaxRuns("abc"), null);
  assert.equal(normalizeMaxRuns(Number.NaN), null);
  assert.equal(normalizeMaxRuns(Infinity), null);
});

test("normalizeMaxRuns clamps absurd values", () => {
  assert.equal(normalizeMaxRuns(999_999_999), MAX_RUNS_LIMIT);
});

test("hasReachedRunLimit is false for unlimited templates", () => {
  assert.equal(hasReachedRunLimit({ maxRuns: null, runCount: 1000 }), false);
  assert.equal(hasReachedRunLimit({}), false);
});

test("hasReachedRunLimit flips once the cap is met", () => {
  assert.equal(hasReachedRunLimit({ maxRuns: 5, runCount: 4 }), false);
  assert.equal(hasReachedRunLimit({ maxRuns: 5, runCount: 5 }), true);
  // Defensive: a cap lowered below the existing count still stops the schedule.
  assert.equal(hasReachedRunLimit({ maxRuns: 2, runCount: 9 }), true);
});

test("runsRemaining reports what's left, never negative", () => {
  assert.equal(runsRemaining({ maxRuns: null, runCount: 3 }), null);
  assert.equal(runsRemaining({ maxRuns: 5, runCount: 2 }), 3);
  assert.equal(runsRemaining({ maxRuns: 5, runCount: 9 }), 0);
});

test("formatRunUsage renders both unlimited and capped templates", () => {
  assert.equal(formatRunUsage({ maxRuns: null, runCount: 1 }), "1 run");
  assert.equal(formatRunUsage({ maxRuns: null, runCount: 4 }), "4 runs");
  assert.equal(formatRunUsage({ maxRuns: 5, runCount: 3 }), "3 / 5 runs");
});
