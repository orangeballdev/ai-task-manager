/**
 * Unit tests for the throttle-detection output parser.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/output-parser.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseOutput } from "../output-parser.js";

describe("parseOutput — real usage-limit messages", () => {
  it("matches a session limit with a reset time", () => {
    const result = parseOutput("You've hit your session limit · resets 10:30pm (UTC)");
    assert.equal(result.shouldRetry, true);
    assert.ok(result.retryAfter);
  });

  it("matches a plain limit (no qualifier) with a reset time", () => {
    const result = parseOutput("You've hit your limit · resets 5am (UTC)");
    assert.equal(result.shouldRetry, true);
  });

  it("matches a weekly limit with a reset time — the original regression", () => {
    const result = parseOutput("You've hit your weekly limit · resets 8am (UTC)");
    assert.equal(result.shouldRetry, true);
  });

  it("matches daily/monthly/hourly qualifiers", () => {
    for (const qualifier of ["daily", "monthly", "hourly"]) {
      const result = parseOutput(`You've hit your ${qualifier} limit · resets 3am (UTC)`);
      assert.equal(result.shouldRetry, true, `expected ${qualifier} to match`);
    }
  });

  it("matches a known qualifier limit with no reset time (defaults to +1h)", () => {
    const result = parseOutput("You've hit your weekly limit");
    assert.equal(result.shouldRetry, true);
  });

  it("still matches when other text follows the reset time", () => {
    const result = parseOutput("You've hit your weekly limit · resets 6pm (UTC). Retrying later.");
    assert.equal(result.shouldRetry, true);
  });

  it("matches try-again-after phrasing on ambiguous/stderr scans", () => {
    const result = parseOutput("Please try again after 20 seconds", { includeAmbiguous: true });
    assert.equal(result.shouldRetry, true);
  });
});

describe("parseOutput — false-positive regression: agent quoting its own bug report", () => {
  const quotedBugReport =
    'regex only recognized "hit your limit" / "hit your session limit". ' +
    '"You\'ve hit your weekly limit · resets 8am (UTC)" matched neither pattern';

  it("does not treat a quoted example of the error string as a live occurrence", () => {
    const result = parseOutput(quotedBugReport);
    assert.equal(result.shouldRetry, false);
  });

  it("still detects a genuine live message appearing later in the same text", () => {
    const mixed = `${quotedBugReport}\n\nActual live output: You've hit your daily limit · resets 3am (UTC)`;
    const result = parseOutput(mixed);
    assert.equal(result.shouldRetry, true);
  });
});

describe("parseOutput — no false triggers on ordinary text", () => {
  it("returns shouldRetry: false for unrelated text", () => {
    const result = parseOutput("Everything looks fine, tests pass.");
    assert.equal(result.shouldRetry, false);
  });
});
