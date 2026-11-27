import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangesSummary, displayChangesSummary } from "../changes-summary";

test("PR tasks keep the PR heading", () => {
  const s = buildChangesSummary("Fix bug", "agent/x", true);
  assert.match(s, /^# PR: Fix bug/);
});

test("branch-only tasks are headed Branch, not PR", () => {
  const s = buildChangesSummary("Fix bug", "main", false);
  assert.match(s, /^# Branch: Fix bug/);
  assert.doesNotMatch(s, /\bPR\b/);
});

test("legacy PR summaries are reworded when the task has no PR", () => {
  const legacy = buildChangesSummary("Fix bug", "main", true);
  const shown = displayChangesSummary(legacy, false)!;
  assert.match(shown, /^# Branch: Fix bug/);
  assert.doesNotMatch(shown, /\bPR\b/);
});

test("summaries are left alone when the task has a PR", () => {
  const legacy = buildChangesSummary("Fix bug", "agent/x", true);
  assert.equal(displayChangesSummary(legacy, true), legacy);
  assert.equal(displayChangesSummary(null, false), null);
});
