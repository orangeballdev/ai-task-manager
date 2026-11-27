/**
 * Unit tests for the app-wide delete-in-flight tracker used to warn users
 * who try to navigate away mid-delete (see NavigationGuard).
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/delete-lock.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  beginDelete,
  endDelete,
  isDeleteInFlight,
  subscribeDeleteState,
  __resetDeleteLockForTests,
} from "../delete-lock.js";

describe("delete-lock", () => {
  beforeEach(() => {
    __resetDeleteLockForTests();
  });

  it("starts with no delete in flight", () => {
    assert.equal(isDeleteInFlight(), false);
  });

  it("reports in-flight once a delete begins", () => {
    beginDelete();
    assert.equal(isDeleteInFlight(), true);
  });

  it("reports not-in-flight once the matching delete ends", () => {
    beginDelete();
    endDelete();
    assert.equal(isDeleteInFlight(), false);
  });

  it("stays in-flight until every concurrent delete has ended", () => {
    beginDelete();
    beginDelete();
    endDelete();
    assert.equal(isDeleteInFlight(), true, "one delete is still pending");
    endDelete();
    assert.equal(isDeleteInFlight(), false);
  });

  it("never goes negative on an unmatched endDelete", () => {
    endDelete();
    endDelete();
    beginDelete();
    assert.equal(isDeleteInFlight(), true);
  });

  it("notifies subscribers on transitions", () => {
    const events: boolean[] = [];
    const unsubscribe = subscribeDeleteState((isDeleting) => events.push(isDeleting));

    beginDelete();
    endDelete();
    unsubscribe();
    beginDelete(); // should not be observed after unsubscribe

    assert.deepEqual(events, [true, false]);
  });
});
