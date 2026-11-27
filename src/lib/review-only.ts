// Review-only tickets — the pure half (unit-tested in __tests__/review-only.test.ts).
//
// A review-only task is a reminder to review work that was done somewhere else: a
// commit pushed by hand, or by another Claude session. It is created straight into
// the In Review column (status "completed" + reviewStatus "in_review") and never
// runs: the worker's pick-up query excludes `reviewOnly` tasks (see
// runnableTaskWhere() below) and every path that would re-queue a task refuses one
// (start, re-run, follow-up message, request changes, review-pr, rebase).
//
// Review decisions: "approve" moves it to Done like any other task, "reopen" moves
// it back to In Review, and "request changes" is *refused* — there is no agent run
// to continue, so the reviewer should create a normal task (on the referenced
// branch) for the agent instead.
//
// The person can attach review metadata — repo, branch, commit SHAs and a PR link —
// when creating the task and edit it later. Every field is optional. It's stored
// in the reviewRepo/reviewBranch/reviewCommits (JSON array)/reviewPrUrl columns.

/** Review metadata as returned by the APIs (get_task, list_tasks, REST). */
export interface ReviewMetadata {
  repo: string | null;
  branch: string | null;
  /** Commit SHAs exactly as given (short or full). */
  commits: string[];
  prUrl: string | null;
}

/** Task columns that hold the metadata. Only keys being changed are present. */
export interface ReviewMetadataColumns {
  reviewRepo?: string | null;
  reviewBranch?: string | null;
  reviewCommits?: string | null;
  reviewPrUrl?: string | null;
}

export type ReviewMetadataParse =
  | { ok: true; columns: ReviewMetadataColumns }
  | { ok: false; field: string; message: string };

/** A commit SHA: 7 to 40 hex characters. */
export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** How many commits one task may reference. */
export const MAX_REVIEW_COMMITS = 50;

/** The API's name for the metadata object, used in error messages. */
export const REVIEW_METADATA_KEY = "reviewMetadata";

const MAX_TEXT = 500;

/**
 * Message every path that would run a review-only task returns. The worker never
 * picks one up, so re-queueing it would only look like it did something.
 */
export const REVIEW_ONLY_RUN_REFUSAL =
  "This is a review-only task — it never runs an agent. Approve it to move it to Done, or create a normal task " +
  "(on the referenced branch) if the work needs changes.";

/** Message for "request changes" on a review-only task. */
export const REVIEW_ONLY_CHANGES_REFUSAL =
  "Request changes isn't available on a review-only task: there is no agent run to continue. Create a normal task " +
  "that works on the referenced branch with your feedback instead, then approve or reopen this one.";

/** The 7-character form shown in the UI. */
export function shortSha(sha: string): string {
  return sha.trim().slice(0, 7);
}

/** True for http(s)://, ssh://, git://, file:// URLs and scp-style `user@host:path`. */
export function isGitUrl(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  if (/^(https?|ssh|git|git\+ssh|file):\/\/[^/]/i.test(v)) {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }
  // scp-style: git@github.com:owner/repo.git
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(v);
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** A branch name git would accept (close enough: no whitespace, no `..`, no leading `-`). */
export function isBranchName(value: string): boolean {
  const v = value.trim();
  return Boolean(v) && v.length <= 255 && !/[\s~^:?*[\\]/.test(v) && !v.includes("..") && !v.startsWith("-") && !v.endsWith("/") && !v.endsWith(".lock");
}

/** Accepts an array of SHAs or one string separated by commas, spaces or new lines. */
export function splitCommitList(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    if (!raw.every((s) => typeof s === "string")) return null;
    return (raw as string[]).flatMap((s) => s.split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof raw === "string") return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return null;
}

function fieldName(key: string): string {
  return `${REVIEW_METADATA_KEY}.${key}`;
}

function bad(key: string, message: string): ReviewMetadataParse {
  return { ok: false, field: fieldName(key), message: `'${fieldName(key)}' ${message}` };
}

/** A string field that may be cleared with null or "". Returns undefined for "not a string". */
function clearableText(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  return v.trim() || null;
}

/**
 * Validates review metadata from any entry point (MCP, REST, the UI forms) and
 * turns it into Task columns. Only keys present in the input are returned, so the
 * same function serves create and partial updates; `null` / `""` / `[]` clears a
 * field. `null` / `undefined` for the whole object means "no change".
 */
export function parseReviewMetadata(raw: unknown): ReviewMetadataParse {
  if (raw === undefined || raw === null) return { ok: true, columns: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field: REVIEW_METADATA_KEY, message: `'${REVIEW_METADATA_KEY}' must be an object: { repo?, branch?, commits?, prUrl? }.` };
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(["repo", "branch", "commits", "prUrl"]);
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length) {
    return {
      ok: false,
      field: fieldName(unknown[0]),
      message: `Unknown field '${fieldName(unknown[0])}'. ${REVIEW_METADATA_KEY} takes repo, branch, commits and prUrl.`,
    };
  }

  const columns: ReviewMetadataColumns = {};

  if (input.repo !== undefined) {
    const repo = clearableText(input.repo);
    if (repo === undefined) return bad("repo", "must be a Git URL string.");
    if (repo !== null && (repo.length > MAX_TEXT || !isGitUrl(repo))) {
      return bad("repo", `must be a Git URL (e.g. https://github.com/owner/repo.git or git@github.com:owner/repo.git), got '${repo.slice(0, 100)}'.`);
    }
    columns.reviewRepo = repo;
  }

  if (input.branch !== undefined) {
    const branch = clearableText(input.branch);
    if (branch === undefined) return bad("branch", "must be a branch name string.");
    if (branch !== null && !isBranchName(branch)) return bad("branch", `isn't a valid branch name: '${branch.slice(0, 100)}'.`);
    columns.reviewBranch = branch;
  }

  if (input.commits !== undefined) {
    if (input.commits === null) {
      columns.reviewCommits = null;
    } else {
      const list = splitCommitList(input.commits);
      if (list === null) return bad("commits", "must be a list of commit SHAs.");
      const invalid = list.filter((s) => !COMMIT_SHA_RE.test(s));
      if (invalid.length) {
        return bad("commits", `must be commit SHAs of 7 to 40 hex characters; invalid: ${invalid.slice(0, 5).map((s) => `'${s.slice(0, 50)}'`).join(", ")}.`);
      }
      // Keep them as given, dropping exact (case-insensitive) duplicates.
      const seen = new Set<string>();
      const unique = list.filter((s) => {
        const key = s.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length > MAX_REVIEW_COMMITS) return bad("commits", `can hold at most ${MAX_REVIEW_COMMITS} SHAs.`);
      columns.reviewCommits = unique.length ? JSON.stringify(unique) : null;
    }
  }

  if (input.prUrl !== undefined) {
    const prUrl = clearableText(input.prUrl);
    if (prUrl === undefined) return bad("prUrl", "must be an http(s) URL string.");
    if (prUrl !== null && (prUrl.length > MAX_TEXT || !isHttpUrl(prUrl))) {
      return bad("prUrl", `must be an http(s) URL, e.g. https://github.com/owner/repo/pull/123, got '${prUrl.slice(0, 100)}'.`);
    }
    columns.reviewPrUrl = prUrl;
  }

  return { ok: true, columns };
}

/** Reads the stored commit list (JSON array). Tolerates a malformed value. */
export function parseStoredCommits(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** The metadata of a task row, in API shape. */
export function readReviewMetadata(task: {
  reviewRepo?: string | null;
  reviewBranch?: string | null;
  reviewCommits?: string | null;
  reviewPrUrl?: string | null;
}): ReviewMetadata {
  return {
    repo: task.reviewRepo ?? null,
    branch: task.reviewBranch ?? null,
    commits: parseStoredCommits(task.reviewCommits),
    prUrl: task.reviewPrUrl ?? null,
  };
}

/** True when any metadata field is set. */
export function hasReviewMetadata(meta: ReviewMetadata): boolean {
  return Boolean(meta.repo || meta.branch || meta.commits.length || meta.prUrl);
}

/**
 * Extra `OR` clauses that make a free-text search match a task's review metadata:
 * commit SHAs (a full SHA also finds a task that stored its short form, by its
 * 7-character prefix) and PR URLs — the review link and an agent's PR(s).
 */
export function reviewSearchClauses(query: string): Record<string, unknown>[] {
  const q = query.trim();
  if (!q) return [];
  const clauses: Record<string, unknown>[] = [
    { reviewCommits: { contains: q } },
    { reviewPrUrl: { contains: q } },
    { reviewRepo: { contains: q } },
    { reviewBranch: { contains: q } },
    { prUrl: { contains: q } },
    { prUrls: { contains: q } },
    { commitSha: { contains: q } },
  ];
  if (COMMIT_SHA_RE.test(q) && q.length > 7) clauses.push({ reviewCommits: { contains: q.slice(0, 7) } });
  return clauses;
}

/**
 * The worker's pick-up filter: the tasks it may start. Kept here (pure) so a test
 * can pin that review-only tasks are never eligible, whatever their status.
 */
export function runnableTaskWhere(now: Date, runningIds: string[]): Record<string, unknown> {
  return {
    isRecurringTemplate: false,
    isEnabled: true,
    reviewOnly: false,
    status: { in: ["pending", "paused", "throttled"] },
    OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    AND: [
      { OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
      { OR: [{ dependsOnTaskId: null }, { dependsOn: { status: { in: ["completed", "no_changes"] } } }] },
    ],
    NOT: runningIds.length > 0 ? { id: { in: runningIds } } : undefined,
  };
}

/** The columns a new review-only task is created with: finished and waiting In Review. */
export function reviewOnlyCreateFields(): {
  reviewOnly: true;
  status: "completed";
  reviewStatus: "in_review";
  isEnabled: true;
} {
  return { reviewOnly: true, status: "completed", reviewStatus: "in_review", isEnabled: true };
}

/** Options that make no sense on a task that never runs; create rejects them. */
export const REVIEW_ONLY_INCOMPATIBLE = [
  "cronExpression", "scheduledFor", "dependsOnTaskId", "teamId", "autoStart", "allowSubtasks",
] as const;

export type ReviewDecision = "approve" | "request_changes" | "reopen";

export type ReviewDecisionPlan =
  | { kind: "error"; message: string }
  | { kind: "request_changes" }
  | { kind: "set_review_status"; reviewStatus: "done" | "in_review" };

const FINISHED = new Set(["completed", "no_changes", "failed", "killed", "timedout"]);

/**
 * What a review decision (MCP review_task) does to a task. Review-only tasks follow
 * the same rules as any finished task, except that request_changes is refused —
 * there's no agent run to continue.
 */
export function planReviewDecision(
  task: { status: string; reviewOnly?: boolean | null },
  decision: ReviewDecision,
): ReviewDecisionPlan {
  if (!task.reviewOnly && (task.status === "running" || task.status === "pending")) {
    return { kind: "error", message: `Task is ${task.status} — wait for it to finish before reviewing it.` };
  }
  if (decision === "request_changes") {
    return task.reviewOnly ? { kind: "error", message: REVIEW_ONLY_CHANGES_REFUSAL } : { kind: "request_changes" };
  }
  if (decision === "approve") {
    if (!task.reviewOnly && !FINISHED.has(task.status)) {
      return { kind: "error", message: `Only finished tasks can be approved (this one is ${task.status}).` };
    }
    return { kind: "set_review_status", reviewStatus: "done" };
  }
  return { kind: "set_review_status", reviewStatus: "in_review" };
}

// ── Display helpers (task page, board) ─────────────────────────────────────

/** "github.com/owner/repo" path parts of a GitHub repo or PR URL, else null. */
export function githubRepoPath(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const v = url.trim();
  const scp = v.match(/^[^@\s]+@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (scp) return { owner: scp[1], repo: scp[2] };
  const http = v.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (http) return { owner: http[1], repo: http[2] };
  return null;
}

/**
 * The https://github.com/owner/repo base used to link commits — from the review
 * repo, or failing that the PR link. Null when neither is on GitHub.
 */
export function githubBaseUrl(meta: Pick<ReviewMetadata, "repo" | "prUrl">): string | null {
  const path = githubRepoPath(meta.repo) ?? (meta.repo ? null : githubRepoPath(meta.prUrl));
  return path ? `https://github.com/${path.owner}/${path.repo}` : null;
}

/** GitHub commit link for a SHA, or null when the repo isn't on GitHub. */
export function githubCommitUrl(meta: Pick<ReviewMetadata, "repo" | "prUrl">, sha: string): string | null {
  const base = githubBaseUrl(meta);
  return base ? `${base}/commit/${sha.trim()}` : null;
}

/** GitHub branch link, or null when the repo isn't on GitHub. */
export function githubBranchUrl(meta: Pick<ReviewMetadata, "repo" | "prUrl">, branch: string): string | null {
  const base = githubBaseUrl(meta);
  return base ? `${base}/tree/${branch.split("/").map(encodeURIComponent).join("/")}` : null;
}

/** True for a github.com pull request URL — the only kind `gh pr view` can report on. */
export function isGitHubPrUrl(url: string | null | undefined): boolean {
  return Boolean(url && /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/#?].*)?$/i.test(url.trim()));
}

/** PR state as the task page shows it — the same signals an agent task's PR carries. */
export interface ReviewPrState {
  number: number | null;
  title: string | null;
  /** open | draft | merged | closed */
  state: "open" | "draft" | "merged" | "closed";
  /** conflicting | mergeable | unknown | null (still computing) */
  mergeableState: "conflicting" | "mergeable" | "unknown" | null;
  /** none | passing | pending | failing */
  ciStatus: "none" | "passing" | "pending" | "failing";
}

/**
 * Parses `gh pr view <url> --json number,title,state,isDraft,mergeable,statusCheckRollup`.
 * Returns null for output that isn't a PR.
 */
export function parseGhPrView(stdout: string): ReviewPrState | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || typeof data.state !== "string") return null;
  const rawState = data.state.toUpperCase();
  const state: ReviewPrState["state"] =
    rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : data.isDraft === true ? "draft" : "open";

  const mergeable = typeof data.mergeable === "string" ? data.mergeable.toUpperCase() : "";
  const mergeableState: ReviewPrState["mergeableState"] =
    mergeable === "CONFLICTING" ? "conflicting" : mergeable === "MERGEABLE" ? "mergeable" : mergeable === "UNKNOWN" ? null : "unknown";

  let ciStatus: ReviewPrState["ciStatus"] = "none";
  const checks = Array.isArray(data.statusCheckRollup) ? (data.statusCheckRollup as Record<string, unknown>[]) : [];
  for (const c of checks) {
    // CheckRun: status + conclusion. StatusContext: state.
    const status = String(c.status ?? "").toUpperCase();
    const conclusion = String(c.conclusion ?? "").toUpperCase();
    const ctxState = String(c.state ?? "").toUpperCase();
    const failing = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"].includes(conclusion) ||
      ["FAILURE", "ERROR"].includes(ctxState);
    const pending = (status && status !== "COMPLETED") || ["PENDING", "EXPECTED"].includes(ctxState);
    if (failing) ciStatus = "failing";
    else if (pending && ciStatus !== "failing") ciStatus = "pending";
    else if (ciStatus === "none") ciStatus = "passing";
  }

  return {
    number: typeof data.number === "number" ? data.number : null,
    title: typeof data.title === "string" ? data.title : null,
    state,
    mergeableState: state === "open" || state === "draft" ? mergeableState : null,
    ciStatus: state === "open" || state === "draft" ? ciStatus : "none",
  };
}

// ── Creating one ───────────────────────────────────────────────────────────

/** What a caller may pass when creating a review-only task (a subset of CreateTaskInput). */
export interface ReviewOnlyCreateInput {
  title?: string;
  description?: string;
  context?: string;
  priority?: string;
  labels?: string[];
  notes?: string;
  reviewMetadata?: unknown;
  // Run options — rejected, since the task never runs.
  repos?: unknown[];
  cronExpression?: string;
  scheduledFor?: string | Date;
  dependsOnTaskId?: string;
  teamId?: string | null;
  autoStart?: boolean;
  allowSubtasks?: boolean;
}

/** Task columns for a new review-only task, minus position/priority normalisation done by the caller. */
export interface ReviewOnlyCreateData extends ReviewMetadataColumns {
  title: string;
  description: string;
  context: string | null;
  labels: string | null;
  notes: string | null;
  outputType: "result";
  reviewOnly: true;
  status: "completed";
  reviewStatus: "in_review";
  isEnabled: true;
}

/**
 * Validates a create request for a review-only task and builds its columns. Run
 * options (schedule, dependency, team, recurring, repos to clone, …) make no sense
 * on it and are rejected rather than silently dropped.
 */
export function planReviewOnlyCreate(
  input: ReviewOnlyCreateInput,
): { ok: true; data: ReviewOnlyCreateData } | { ok: false; field: string; message: string } {
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description) {
    return { ok: false, field: "description", message: "'description' is required: say what to review and why (e.g. the commit message)." };
  }

  const incompatible = ([
    ["cronExpression", typeof input.cronExpression === "string" && input.cronExpression.trim()],
    ["scheduledFor", input.scheduledFor],
    ["dependsOnTaskId", input.dependsOnTaskId],
    ["teamId", input.teamId],
    ["autoStart", input.autoStart === false],
    ["allowSubtasks", input.allowSubtasks],
    ["repos", Array.isArray(input.repos) && input.repos.length > 0],
  ] as const).filter(([, v]) => Boolean(v)).map(([k]) => k);
  if (incompatible.length) {
    const reposHint = incompatible.includes("repos") ? " Put the repository in reviewMetadata.repo instead of repos." : "";
    return {
      ok: false,
      field: incompatible[0],
      message: `${incompatible.join(", ")} can't be used with reviewOnly — a review-only task never runs.${reposHint}`,
    };
  }

  if (input.labels !== undefined && input.labels !== null && (!Array.isArray(input.labels) || !input.labels.every((l) => typeof l === "string"))) {
    return { ok: false, field: "labels", message: "'labels' must be an array of strings." };
  }

  const meta = parseReviewMetadata(input.reviewMetadata);
  if (!meta.ok) return meta;

  const labels = (input.labels ?? []).map((l) => l.trim()).filter(Boolean);
  return {
    ok: true,
    data: {
      title: (typeof input.title === "string" && input.title.trim()) || description.slice(0, 80),
      description,
      context: typeof input.context === "string" && input.context.trim() ? input.context.trim() : null,
      labels: labels.length ? JSON.stringify(labels) : null,
      notes: typeof input.notes === "string" && input.notes.trim() ? input.notes : null,
      // Nothing is cloned or produced; "result" keeps the repo requirement and the
      // repo-centric UI (On finish, workspace) out of the way.
      outputType: "result",
      ...meta.columns,
      ...reviewOnlyCreateFields(),
    },
  };
}
