/**
 * Unit tests for which tasks automatic cleanup may delete.
 *
 *   npx tsx --test src/lib/__tests__/task-retention.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRetentionScope, selectTasksForCleanup, type TaskCleanupCandidate } from "../task-retention";

function task(id: string, opts: Partial<TaskCleanupCandidate> = {}): TaskCleanupCandidate {
  return { id, status: "completed", reviewStatus: null, prUrl: null, prUrls: null, ...opts };
}

describe("selectTasksForCleanup", () => {
  const tasks = [
    task("approved", { reviewStatus: "done" }),
    task("in-review"),
    task("no-changes", { status: "no_changes" }),
    task("no-changes-open-pr", { status: "no_changes", prUrl: "https://github.com/o/r/pull/1" }),
    task("failed", { status: "failed" }),
    task("killed", { status: "killed" }),
    task("failed-marked-done", { status: "failed", reviewStatus: "done" }),
    task("running", { status: "running" }),
  ];

  it("'all' deletes every finished task", () => {
    assert.deepEqual(selectTasksForCleanup(tasks, "all"), [
      "approved", "in-review", "no-changes", "no-changes-open-pr", "failed", "killed", "failed-marked-done",
    ]);
  });

  it("'done' only deletes tasks in the Done column", () => {
    assert.deepEqual(selectTasksForCleanup(tasks, "done"), ["approved", "no-changes", "failed-marked-done"]);
  });

  it("never deletes unfinished tasks", () => {
    assert.deepEqual(selectTasksForCleanup([task("r", { status: "running", reviewStatus: "done" })], "done"), []);
  });
});

describe("parseRetentionScope", () => {
  it("defaults to 'all'", () => {
    assert.equal(parseRetentionScope(undefined), "all");
    assert.equal(parseRetentionScope("bogus"), "all");
    assert.equal(parseRetentionScope("done"), "done");
  });
});
