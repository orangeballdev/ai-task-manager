import { test } from "node:test";
import assert from "node:assert/strict";
import { taskMessageMode, canMessageTask } from "../task-message-mode";

test("taskMessageMode maps statuses to the message route's branches", () => {
  assert.equal(taskMessageMode("running"), "live");
  assert.equal(taskMessageMode("paused"), "held");
  assert.equal(taskMessageMode("awaiting_approval"), "held");
  assert.equal(taskMessageMode("throttled"), "held");
  for (const s of ["completed", "no_changes", "failed", "killed", "timedout"]) {
    assert.equal(taskMessageMode(s), "followup", s);
  }
  assert.equal(taskMessageMode("pending"), null);
  assert.equal(taskMessageMode("backlog"), null);
});

test("canMessageTask is true exactly when a mode exists", () => {
  assert.equal(canMessageTask("running"), true);
  assert.equal(canMessageTask("failed"), true);
  assert.equal(canMessageTask("pending"), false);
});
