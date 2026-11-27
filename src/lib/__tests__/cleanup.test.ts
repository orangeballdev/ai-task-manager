/**
 * Unit tests for the File-cleanup protection logic.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/cleanup.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeDeletableFileIds, type FileCleanupNode } from "../cleanup";

const OLD = new Date("2020-01-01T00:00:00Z");
const NEW = new Date("2030-01-01T00:00:00Z");
const CUTOFF = new Date("2025-01-01T00:00:00Z");

function node(id: string, parentId: string | null, opts: Partial<FileCleanupNode> = {}): FileCleanupNode {
  return { id, parentId, protected: false, createdAt: OLD, ...opts };
}

describe("computeDeletableFileIds", () => {
  it("deletes old, unprotected files and leaves new ones alone", () => {
    const files = [node("a", null), node("b", null, { createdAt: NEW })];
    assert.deepEqual(computeDeletableFileIds(files, CUTOFF).sort(), ["a"]);
  });

  it("never deletes a file marked protected, even if old", () => {
    const files = [node("a", null, { protected: true })];
    assert.deepEqual(computeDeletableFileIds(files, CUTOFF), []);
  });

  it("protecting a folder also protects its (unmarked) descendants", () => {
    const files = [
      node("folder", null, { protected: true }),
      node("child", "folder"),
      node("grandchild", "child"),
    ];
    assert.deepEqual(computeDeletableFileIds(files, CUTOFF), []);
  });

  it("keeps an old unprotected ancestor folder alive if any descendant is protected, to avoid cascade-deleting it", () => {
    const files = [
      node("folder", null),
      node("protectedChild", "folder", { protected: true }),
    ];
    assert.deepEqual(computeDeletableFileIds(files, CUTOFF), []);
  });

  it("still cleans up old unprotected siblings even when a sibling deep in the tree is protected", () => {
    const files = [
      node("folder", null),
      node("protectedChild", "folder", { protected: true }),
      node("oldSibling", "folder"),
    ];
    // `folder` must survive (cascade risk to protectedChild), but the
    // unrelated old sibling file can still be individually cleaned up.
    assert.deepEqual(computeDeletableFileIds(files, CUTOFF).sort(), ["oldSibling"]);
  });

  it("deletes a whole old, fully-unprotected subtree", () => {
    const files = [
      node("folder", null),
      node("child1", "folder"),
      node("child2", "folder"),
    ];
    assert.deepEqual(computeDeletableFileIds(files, CUTOFF).sort(), ["child1", "child2", "folder"]);
  });
});
