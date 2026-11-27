/**
 * Unit tests for decidePrAction — the worker's "open a PR for this repo?" decision.
 *
 * Run with:
 *   npx tsx --test src/lib/__tests__/pr-decision.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decidePrAction, type PrDecisionInput } from "../pr-decision";

const base: PrDecisionInput = {
  createPR: true,
  workOnExistingBranch: false,
  hasToken: true,
  hadChanges: true,
  commitsAheadOfBase: 2,
};

describe("decidePrAction", () => {
  it("creates a PR when requested and the branch has commits", () => {
    assert.deepEqual(decidePrAction(base), { action: "create" });
  });

  it("skips when the task didn't ask for a PR", () => {
    assert.equal(decidePrAction({ ...base, createPR: false }).action, "skip");
  });

  it("skips for tasks that push straight to an existing branch", () => {
    assert.equal(decidePrAction({ ...base, workOnExistingBranch: true }).action, "skip");
  });

  it("errors (rather than silently skipping) when no token is configured", () => {
    const d = decidePrAction({ ...base, hasToken: false });
    assert.equal(d.action, "error");
  });

  it("still opens the PR on a retry whose commits were pushed by an earlier run", () => {
    // This run made no new commits, but the branch is ahead of base — the previous
    // run pushed and then failed to open the PR.
    assert.deepEqual(decidePrAction({ ...base, hadChanges: false, commitsAheadOfBase: 3 }), { action: "create" });
  });

  it("reports no_changes when the branch is level with base", () => {
    assert.deepEqual(decidePrAction({ ...base, hadChanges: false, commitsAheadOfBase: 0 }), { action: "no_changes" });
  });

  it("does not require a token when there's nothing to open a PR for", () => {
    assert.deepEqual(decidePrAction({ ...base, hasToken: false, hadChanges: false, commitsAheadOfBase: 0 }), { action: "no_changes" });
  });

  it("falls back to this run's changes when the base comparison is unavailable", () => {
    assert.deepEqual(decidePrAction({ ...base, commitsAheadOfBase: null }), { action: "create" });
    assert.deepEqual(decidePrAction({ ...base, hadChanges: false, commitsAheadOfBase: null }), { action: "no_changes" });
  });
});
