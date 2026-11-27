/**
 * Unit tests for Kanban column derivation — in particular the "Review PR" self-review
 * flow, where a task can finish with status `no_changes` (no new commits this round)
 * while its pull request is still open and unmerged.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/kanban-column.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { columnFor, isHiddenOnBoard, visibleOnBoard } from "../kanban-column";
import type { Task } from "../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
    description: "desc",
    context: null,
    provider: "cli",
    model: null,
    status: "completed",
    position: 0,
    priority: "normal",
    effort: null,
    retryCount: 0,
    reviewIterationCount: 0,
    nextRetryAt: null,
    scheduledFor: null,
    workspacePath: null,
    inputTokens: null,
    outputTokens: null,
    estimatedCost: null,
    branchName: null,
    commitSha: null,
    prSummary: null,
    cronExpression: null,
    maxRuns: null,
    runCount: 0,
    pushToMain: false,
    targetBranch: null,
    createPR: true,
    prUrl: null,
    prNumber: null,
    prUrls: null,
    prError: null,
    mergeableState: null,
    ciStatus: null,
    hasConflict: false,
    conflictMessage: null,
    noChanges: false,
    tokenBudget: null,
    costBudget: null,
    attachments: null,
    attachmentsFolder: null,
    contextFiles: null,
    notes: null,
    labels: null,
    sourceEmail: null,
    testPlan: null,
    reviewStatus: null,
    systemPrompt: null,
    outputType: "repository",
    isRecurringTemplate: false,
    isEnabled: true,
    isHailMary: false,
    createValidationTask: false,
    lastScheduledAt: null,
    recurringTemplateId: null,
    hailMaryEligible: false,
    hailMaryBurstLimit: null,
    aiProviderId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repos: [],
    ...overrides,
  };
}

describe("columnFor", () => {
  it("sends a brand-new no_changes task (no PR ever opened) to Done", () => {
    const task = makeTask({ status: "no_changes", prUrl: null, prUrls: null });
    assert.equal(columnFor(task), "done");
  });

  it("keeps a 'no changes requested' self-review re-run in In Review while its PR is still open", () => {
    // This is the review-pr flow: the task already had an open PR, the agent re-ran to
    // review it, found nothing to fix, and finished with status `no_changes`. The PR
    // itself is untouched — still open — so the task must not jump to Done.
    const task = makeTask({ status: "no_changes", prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 });
    assert.equal(columnFor(task), "in_review");
  });

  it("keeps a no_changes task with a multi-repo prUrls map (but no legacy prUrl) in In Review", () => {
    const task = makeTask({
      status: "no_changes",
      prUrl: null,
      prUrls: JSON.stringify({ repoA: { url: "https://github.com/org/a/pull/1", number: 1 } }),
    });
    assert.equal(columnFor(task), "in_review");
  });

  it("sends a no_changes task to Done once its PR has been confirmed merged (reviewStatus done)", () => {
    const task = makeTask({
      status: "no_changes",
      prUrl: "https://github.com/org/repo/pull/1",
      prNumber: 1,
      reviewStatus: "done",
    });
    assert.equal(columnFor(task), "done");
  });

  it("still sends a normal completed task (changes made, review not yet done) to In Review", () => {
    const task = makeTask({ status: "completed", prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 });
    assert.equal(columnFor(task), "in_review");
  });

  it("leaves running/paused tasks in In Progress and other statuses in To Do — unaffected by the PR-review fix", () => {
    assert.equal(columnFor(makeTask({ status: "running" })), "in_progress");
    assert.equal(columnFor(makeTask({ status: "paused" })), "in_progress");
    assert.equal(columnFor(makeTask({ status: "awaiting_approval" })), "in_progress");
    assert.equal(columnFor(makeTask({ status: "pending" })), "todo");
    assert.equal(columnFor(makeTask({ status: "failed" })), "todo");
  });

  it("still honors manual reviewStatus=done regardless of status or open PRs (manual drag-and-drop path)", () => {
    const task = makeTask({ status: "completed", prUrl: "https://github.com/org/repo/pull/1", reviewStatus: "done" });
    assert.equal(columnFor(task), "done");
  });

  it("keeps a no-PR no_changes task out of In Review even with a stale reviewStatus=in_review", () => {
    // A retried task keeps the reviewStatus its earlier (changes-making) run set; if the
    // retry made no changes and no PR is open there's nothing to review.
    const task = makeTask({ status: "no_changes", prUrl: null, prUrls: null, reviewStatus: "in_review" });
    assert.equal(columnFor(task), "done");
  });

  it("still honors reviewStatus=in_review for a no_changes task whose PR is open", () => {
    const task = makeTask({ status: "no_changes", prUrl: "https://github.com/org/repo/pull/1", prNumber: 1, reviewStatus: "in_review" });
    assert.equal(columnFor(task), "in_review");
  });
});

describe("hidden To Do cards", () => {
  it("hides a pending task flagged hiddenOnBoard", () => {
    const task = makeTask({ status: "pending", hiddenOnBoard: true });
    assert.equal(isHiddenOnBoard(task), true);
  });

  it("does not hide unflagged tasks", () => {
    assert.equal(isHiddenOnBoard(makeTask({ status: "pending" })), false);
    assert.equal(isHiddenOnBoard(makeTask({ status: "pending", hiddenOnBoard: false })), false);
  });

  it("shows a hidden task again once it leaves To Do", () => {
    assert.equal(isHiddenOnBoard(makeTask({ status: "running", hiddenOnBoard: true })), false);
    assert.equal(isHiddenOnBoard(makeTask({ status: "completed", hiddenOnBoard: true })), false);
    assert.equal(isHiddenOnBoard(makeTask({ status: "completed", reviewStatus: "done", hiddenOnBoard: true })), false);
  });

  it("filters hidden cards only when showHidden is off", () => {
    const hidden = makeTask({ id: "h", status: "pending", hiddenOnBoard: true });
    const shown = makeTask({ id: "s", status: "pending" });
    assert.deepEqual(visibleOnBoard([hidden, shown], false).map((t) => t.id), ["s"]);
    assert.deepEqual(visibleOnBoard([hidden, shown], true).map((t) => t.id), ["h", "s"]);
  });
});
