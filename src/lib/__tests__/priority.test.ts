/**
 * Unit tests for task priority ordering.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/priority.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PRIORITY_LEVELS,
  DEFAULT_PRIORITY,
  normalizePriority,
  priorityWeight,
  comparePriorityThenPosition,
} from "../priority";

describe("normalizePriority", () => {
  it("passes through valid priority values", () => {
    for (const level of PRIORITY_LEVELS) {
      assert.equal(normalizePriority(level), level);
    }
  });

  it("falls back to the default for null/undefined/unknown values", () => {
    assert.equal(normalizePriority(null), DEFAULT_PRIORITY);
    assert.equal(normalizePriority(undefined), DEFAULT_PRIORITY);
    assert.equal(normalizePriority("not-a-priority"), DEFAULT_PRIORITY);
    assert.equal(normalizePriority(""), DEFAULT_PRIORITY);
  });
});

describe("priorityWeight", () => {
  it("ranks urgent > high > normal > low", () => {
    assert.ok(priorityWeight("urgent") > priorityWeight("high"));
    assert.ok(priorityWeight("high") > priorityWeight("normal"));
    assert.ok(priorityWeight("normal") > priorityWeight("low"));
  });
});

describe("comparePriorityThenPosition", () => {
  it("mirrors the worker's pick-up order: higher priority first, position breaks ties", () => {
    const tasks = [
      { id: "a", priority: "normal", position: 0 },
      { id: "b", priority: "urgent", position: 5 },
      { id: "c", priority: "low", position: 1 },
      { id: "d", priority: "urgent", position: 2 },
      { id: "e", priority: "normal", position: 1 },
    ];

    const sorted = [...tasks].sort(comparePriorityThenPosition).map((t) => t.id);

    // "d" (urgent, pos 2) runs before "b" (urgent, pos 5) — same priority, position tiebreak.
    // Both urgent tasks run before the normal tasks, which run before the low task.
    assert.deepEqual(sorted, ["d", "b", "a", "e", "c"]);
  });

  it("treats a missing/unset priority the same as the default (normal)", () => {
    const tasks = [
      { id: "a", priority: null, position: 0 },
      { id: "b", priority: "high", position: 10 },
      { id: "c", priority: "normal", position: 1 },
    ];

    const sorted = [...tasks].sort(comparePriorityThenPosition).map((t) => t.id);
    assert.deepEqual(sorted, ["b", "a", "c"]);
  });
});
