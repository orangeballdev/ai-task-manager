/**
 * Unit tests for the task "thinking effort" option.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/effort.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EFFORT_LEVELS, isTaskEffort, normalizeEffort } from "../effort";

describe("isTaskEffort", () => {
  it("accepts every level in EFFORT_LEVELS", () => {
    for (const level of EFFORT_LEVELS) {
      assert.equal(isTaskEffort(level), true);
    }
  });

  it("rejects invalid values", () => {
    assert.equal(isTaskEffort(null), false);
    assert.equal(isTaskEffort(undefined), false);
    assert.equal(isTaskEffort(""), false);
    assert.equal(isTaskEffort("not-a-level"), false);
    assert.equal(isTaskEffort(42), false);
  });
});

describe("normalizeEffort", () => {
  it("passes through valid effort levels", () => {
    for (const level of EFFORT_LEVELS) {
      assert.equal(normalizeEffort(level), level);
    }
  });

  it("returns null (not a default level) for unset/invalid values", () => {
    assert.equal(normalizeEffort(null), null);
    assert.equal(normalizeEffort(undefined), null);
    assert.equal(normalizeEffort(""), null);
    assert.equal(normalizeEffort("not-a-level"), null);
  });
});
