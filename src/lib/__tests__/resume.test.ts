/**
 * Unit tests for shouldResumeTask — the worker's resume-detection helper.
 *
 * retryCount and reviewIterationCount are intentionally separate counters (see
 * src/app/api/tasks/[id]/review-pr/route.ts): a "Review PR" self-review re-run bumps
 * reviewIterationCount, not retryCount, so it isn't misreported as a task failure/retry
 * in the UI. The worker must still resume on the existing branch/workspace either way.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/resume.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldResumeTask } from "../resume";

describe("shouldResumeTask", () => {
  it("is false for a fresh task with no retries or review iterations", () => {
    assert.equal(shouldResumeTask({ retryCount: 0, reviewIterationCount: 0 }), false);
  });

  it("is true when retryCount alone is > 0 (an actual failure retry)", () => {
    assert.equal(shouldResumeTask({ retryCount: 1, reviewIterationCount: 0 }), true);
  });

  it("is true when reviewIterationCount alone is > 0 (a Review PR re-run, not a failure)", () => {
    assert.equal(shouldResumeTask({ retryCount: 0, reviewIterationCount: 1 }), true);
  });

  it("is true when both counters are > 0", () => {
    assert.equal(shouldResumeTask({ retryCount: 2, reviewIterationCount: 3 }), true);
  });

  it("treats a missing reviewIterationCount (older rows / optional field) as 0", () => {
    assert.equal(shouldResumeTask({ retryCount: 0 }), false);
    assert.equal(shouldResumeTask({ retryCount: 1 }), true);
  });
});
