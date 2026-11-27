import { test } from "node:test";
import assert from "node:assert/strict";
import {
  githubBranchUrl,
  githubCommitUrl,
  isGitUrl,
  parseGhPrView,
  parseReviewMetadata,
  parseStoredCommits,
  planReviewDecision,
  planReviewOnlyCreate,
  readReviewMetadata,
  reviewSearchClauses,
  runnableTaskWhere,
  shortSha,
  REVIEW_ONLY_CHANGES_REFUSAL,
} from "../review-only";
import { McpToolError } from "../mcp/protocol";
import { planTaskEdit, type EditableTask } from "../mcp/task-update";
import { columnFor } from "../kanban-column";
import type { Task } from "../types";

// The example from the feature request: commit 65948886 pushed by hand to develop.
const LOGS_SAAS = "git@github.com:acme/widgets.git";
const DESCRIPTION =
  "Show the executive summary read-only until the poster chooses Edit.\n\n" +
  "Commit 65948886 on develop: the summary now renders as text and only becomes editable after clicking Edit.";

// ── Creating one ───────────────────────────────────────────────────────────

test("creates a review-only task with a description and metadata, straight into In Review", () => {
  const plan = planReviewOnlyCreate({
    title: "Show the executive summary read-only until the poster chooses Edit",
    description: DESCRIPTION,
    labels: ["frontend"],
    notes: "Pushed from another Claude session",
    reviewMetadata: { repo: LOGS_SAAS, branch: "develop", commits: ["65948886"] },
  });
  assert.ok(plan.ok);
  const d = plan.data;
  assert.equal(d.title, "Show the executive summary read-only until the poster chooses Edit");
  assert.equal(d.description, DESCRIPTION);
  assert.equal(d.labels, JSON.stringify(["frontend"]));
  assert.equal(d.notes, "Pushed from another Claude session");
  assert.equal(d.reviewRepo, LOGS_SAAS);
  assert.equal(d.reviewBranch, "develop");
  assert.equal(d.reviewCommits, JSON.stringify(["65948886"]));
  assert.equal(d.reviewPrUrl, undefined);
  // Finished and waiting In Review, never runnable.
  assert.equal(d.reviewOnly, true);
  assert.equal(d.status, "completed");
  assert.equal(d.reviewStatus, "in_review");

  const row = { ...d, prUrl: null, prUrls: null } as unknown as Task;
  assert.equal(columnFor(row), "in_review");
  assert.deepEqual(readReviewMetadata(d), { repo: LOGS_SAAS, branch: "develop", commits: ["65948886"], prUrl: null });
});

test("the title defaults from the description, like any task", () => {
  const plan = planReviewOnlyCreate({ description: DESCRIPTION });
  assert.ok(plan.ok);
  assert.equal(plan.data.title, DESCRIPTION.slice(0, 80));
  // Metadata is optional.
  assert.equal(plan.data.reviewRepo, undefined);
  assert.equal(plan.data.reviewCommits, undefined);
});

test("the description is required", () => {
  const plan = planReviewOnlyCreate({ title: "x", description: "   " });
  assert.equal(plan.ok, false);
  assert.ok(!plan.ok && plan.field === "description");
});

test("run options are rejected, not silently dropped", () => {
  const withRepos = planReviewOnlyCreate({ description: "d", repos: [{ url: LOGS_SAAS }] });
  assert.ok(!withRepos.ok && /repos/.test(withRepos.message) && /reviewMetadata\.repo/.test(withRepos.message));
  const scheduled = planReviewOnlyCreate({ description: "d", cronExpression: "0 9 * * *", teamId: "t1" });
  assert.ok(!scheduled.ok && /cronExpression, teamId/.test(scheduled.message));
  assert.equal(planReviewOnlyCreate({ description: "d", autoStart: false }).ok, false);
  assert.equal(planReviewOnlyCreate({ description: "d", autoStart: true }).ok, true);
});

// ── Validating the metadata ────────────────────────────────────────────────

test("accepts short and full SHAs, stores them as given, shows the short form", () => {
  const full = "65948886a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const r = parseReviewMetadata({ commits: ["65948886", full, "ABCDEF1"] });
  assert.ok(r.ok);
  assert.deepEqual(parseStoredCommits(r.columns.reviewCommits), ["65948886", full, "ABCDEF1"]);
  assert.equal(shortSha(full), "6594888");
  // A comma/space separated string (the UI's input) works too, and duplicates collapse.
  const s = parseReviewMetadata({ commits: "65948886, a1b2c3d4 65948886" });
  assert.ok(s.ok);
  assert.deepEqual(parseStoredCommits(s.columns.reviewCommits), ["65948886", "a1b2c3d4"]);
});

test("rejects bad SHAs and names the field", () => {
  for (const bad of ["abc12", "6594888z", "a".repeat(41), "65948886-dirty"]) {
    const r = parseReviewMetadata({ commits: [bad] });
    assert.ok(!r.ok, bad);
    assert.equal(r.field, "reviewMetadata.commits");
    assert.match(r.message, /reviewMetadata\.commits/);
    assert.match(r.message, /7 to 40 hex/);
  }
  const notList = parseReviewMetadata({ commits: 42 });
  assert.ok(!notList.ok && notList.field === "reviewMetadata.commits");
});

test("the PR link must be an http(s) URL", () => {
  assert.ok(parseReviewMetadata({ prUrl: "https://github.com/acme/widgets/pull/12" }).ok);
  assert.ok(parseReviewMetadata({ prUrl: "http://gitlab.internal/acme/web/-/merge_requests/3" }).ok);
  for (const bad of ["ftp://example.com/pr/1", "github.com/acme/web/pull/1", "javascript:alert(1)", "not a url"]) {
    const r = parseReviewMetadata({ prUrl: bad });
    assert.ok(!r.ok, bad);
    assert.equal(r.field, "reviewMetadata.prUrl");
    assert.match(r.message, /http\(s\) URL/);
  }
});

test("the repo must be a Git URL; the branch a branch name", () => {
  for (const ok of [LOGS_SAAS, "https://github.com/acme/web.git", "ssh://git@host:22/acme/web.git", "https://gitlab.com/a/b"]) {
    assert.ok(isGitUrl(ok), ok);
  }
  const badRepo = parseReviewMetadata({ repo: "logs-saas" });
  assert.ok(!badRepo.ok && badRepo.field === "reviewMetadata.repo");
  const badBranch = parseReviewMetadata({ branch: "feature branch" });
  assert.ok(!badBranch.ok && badBranch.field === "reviewMetadata.branch");
  assert.ok(parseReviewMetadata({ branch: "feature/review-only" }).ok);
});

test("unknown keys and non-objects are rejected; null/\"\"/[] clear a field", () => {
  const unknown = parseReviewMetadata({ sha: "65948886" });
  assert.ok(!unknown.ok && unknown.field === "reviewMetadata.sha");
  assert.equal(parseReviewMetadata("65948886").ok, false);
  const cleared = parseReviewMetadata({ repo: null, branch: "", commits: [], prUrl: null });
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.columns, { reviewRepo: null, reviewBranch: null, reviewCommits: null, reviewPrUrl: null });
  // Absent = no change.
  assert.deepEqual(parseReviewMetadata({ branch: "develop" }), { ok: true, columns: { reviewBranch: "develop" } });
  assert.deepEqual(parseReviewMetadata(undefined), { ok: true, columns: {} });
});

test("create rejects invalid metadata with the field's message", () => {
  const plan = planReviewOnlyCreate({ description: "d", reviewMetadata: { commits: ["nope"] } });
  assert.ok(!plan.ok && plan.field === "reviewMetadata.commits");
});

// ── The worker never picks one up ──────────────────────────────────────────

test("the worker's pick-up query excludes review-only tasks", () => {
  const where = runnableTaskWhere(new Date(), []);
  assert.equal(where.reviewOnly, false);
  assert.equal(where.isRecurringTemplate, false);
  assert.deepEqual(where.status, { in: ["pending", "paused", "throttled"] });
  assert.deepEqual(runnableTaskWhere(new Date(), ["a"]).NOT, { id: { in: ["a"] } });

  // Even a review-only row that somehow ended up pending must not match.
  const matches = (row: Record<string, unknown>) =>
    row.reviewOnly === where.reviewOnly && (where.status as { in: string[] }).in.includes(row.status as string);
  assert.equal(matches({ reviewOnly: true, status: "pending" }), false);
  assert.equal(matches({ reviewOnly: false, status: "pending" }), true);
});

// ── Review decisions ───────────────────────────────────────────────────────

test("approve moves a review-only task to Done and reopen moves it back", () => {
  const t = { status: "completed", reviewOnly: true };
  assert.deepEqual(planReviewDecision(t, "approve"), { kind: "set_review_status", reviewStatus: "done" });
  assert.deepEqual(planReviewDecision(t, "reopen"), { kind: "set_review_status", reviewStatus: "in_review" });
});

test("request changes is refused on a review-only task with a clear message", () => {
  const plan = planReviewDecision({ status: "completed", reviewOnly: true }, "request_changes");
  assert.deepEqual(plan, { kind: "error", message: REVIEW_ONLY_CHANGES_REFUSAL });
  assert.match(REVIEW_ONLY_CHANGES_REFUSAL, /normal task/);
});

test("agent tasks keep their existing review rules", () => {
  assert.deepEqual(planReviewDecision({ status: "completed" }, "request_changes"), { kind: "request_changes" });
  assert.equal(planReviewDecision({ status: "running" }, "approve").kind, "error");
  assert.equal(planReviewDecision({ status: "pending" }, "reopen").kind, "error");
  assert.equal(planReviewDecision({ status: "throttled" }, "approve").kind, "error");
  assert.deepEqual(planReviewDecision({ status: "failed" }, "approve"), { kind: "set_review_status", reviewStatus: "done" });
});

// ── Editing (MCP update_task) ──────────────────────────────────────────────

function editable(overrides: Partial<EditableTask> = {}): EditableTask {
  return {
    id: "t1", status: "completed", labels: null, notes: null, outputType: "result", pushToMain: false, createPR: false,
    targetBranch: null, toolAccess: null, isRecurringTemplate: false, cronExpression: null, repos: [], reviewOnly: true,
    ...overrides,
  };
}
const rejects = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof McpToolError && re.test(e.message));

test("update_task edits a review-only task's metadata and ticket fields", () => {
  const plan = planTaskEdit(editable(), {
    title: "New title",
    reviewMetadata: { commits: ["65948886", "a1b2c3d4"], prUrl: "https://github.com/acme/widgets/pull/7" },
  });
  assert.equal(plan.data.title, "New title");
  assert.equal(plan.data.reviewCommits, JSON.stringify(["65948886", "a1b2c3d4"]));
  assert.equal(plan.data.reviewPrUrl, "https://github.com/acme/widgets/pull/7");
  assert.equal("reviewRepo" in plan.data, false);
});

test("update_task rejects run settings on a review-only task, and bad metadata", () => {
  rejects(() => planTaskEdit(editable(), { afterCompletion: "pr" }), /review-only task/);
  rejects(() => planTaskEdit(editable(), { reviewMetadata: { prUrl: "ftp://x/1" } }), /reviewMetadata\.prUrl/);
  rejects(() => planTaskEdit(editable({ reviewOnly: false }), { reviewMetadata: { branch: "develop" } }), /only applies to review-only/);
});

// ── Search and display ─────────────────────────────────────────────────────

test("list_tasks search matches commit SHAs and PR URLs", () => {
  const clauses = reviewSearchClauses("65948886a1b2");
  assert.ok(clauses.some((c) => JSON.stringify(c) === JSON.stringify({ reviewCommits: { contains: "65948886a1b2" } })));
  // A longer SHA also finds a ticket that stored the 7-char short form.
  assert.ok(clauses.some((c) => JSON.stringify(c) === JSON.stringify({ reviewCommits: { contains: "6594888" } })));
  const pr = reviewSearchClauses("https://github.com/acme/web/pull/4");
  assert.ok(pr.some((c) => "reviewPrUrl" in c));
  assert.ok(pr.some((c) => "prUrl" in c));
  assert.deepEqual(reviewSearchClauses("  "), []);
});

test("commits and branches link to GitHub only for GitHub repos", () => {
  assert.equal(
    githubCommitUrl({ repo: LOGS_SAAS, prUrl: null }, "65948886"),
    "https://github.com/acme/widgets/commit/65948886",
  );
  assert.equal(githubBranchUrl({ repo: "https://github.com/acme/web.git", prUrl: null }, "feat/x"), "https://github.com/acme/web/tree/feat/x");
  // No repo: fall back to the PR link's repo.
  assert.equal(
    githubCommitUrl({ repo: null, prUrl: "https://github.com/acme/web/pull/4" }, "a1b2c3d"),
    "https://github.com/acme/web/commit/a1b2c3d",
  );
  assert.equal(githubCommitUrl({ repo: "https://gitlab.com/acme/web.git", prUrl: null }, "a1b2c3d"), null);
});

test("parseGhPrView reads the PR state like an agent PR's", () => {
  const open = parseGhPrView(JSON.stringify({
    number: 12, title: "Read-only summary", state: "OPEN", isDraft: false, mergeable: "CONFLICTING",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }],
  }));
  assert.deepEqual(open, { number: 12, title: "Read-only summary", state: "open", mergeableState: "conflicting", ciStatus: "failing" });
  const pending = parseGhPrView(JSON.stringify({ number: 1, title: "t", state: "OPEN", isDraft: true, mergeable: "MERGEABLE", statusCheckRollup: [{ status: "IN_PROGRESS" }] }));
  assert.equal(pending?.state, "draft");
  assert.equal(pending?.ciStatus, "pending");
  const merged = parseGhPrView(JSON.stringify({ number: 2, title: "t", state: "MERGED", mergeable: "UNKNOWN", statusCheckRollup: [] }));
  assert.deepEqual(merged, { number: 2, title: "t", state: "merged", mergeableState: null, ciStatus: "none" });
  assert.equal(parseGhPrView("not json"), null);
});
