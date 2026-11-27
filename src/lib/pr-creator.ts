export type GitProvider = "github" | "gitlab" | "other";

export interface PRResult {
  url: string;
  number: number;
}

/** Detect provider from a repo URL. */
export function detectProvider(repoUrl: string): GitProvider {
  const url = repoUrl.toLowerCase();
  if (url.includes("github.com")) return "github";
  if (url.includes("gitlab.")) return "gitlab";
  return "other";
}

function parseRepoPath(repoUrl: string): string {
  const https = repoUrl.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (https) return https[1];
  const ssh = repoUrl.match(/git@[^:]+:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1];
  throw new Error(`Cannot parse repo path from URL: ${repoUrl}`);
}

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Create `branch` in the repo, pointing at the repo's current default branch, if it doesn't already exist. */
async function ensureGitHubBranchExists(repoPath: string, branch: string, token: string): Promise<void> {
  const existing = await fetch(`https://api.github.com/repos/${repoPath}/branches/${encodeURIComponent(branch)}`, {
    headers: githubHeaders(token),
  });
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(`GitHub branch lookup failed (${existing.status}): ${await existing.text()}`);
  }

  const repoRes = await fetch(`https://api.github.com/repos/${repoPath}`, { headers: githubHeaders(token) });
  if (!repoRes.ok) {
    throw new Error(`GitHub repo lookup failed (${repoRes.status}): ${await repoRes.text()}`);
  }
  const { default_branch: defaultBranch } = await repoRes.json() as { default_branch: string };

  const refRes = await fetch(`https://api.github.com/repos/${repoPath}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, {
    headers: githubHeaders(token),
  });
  if (!refRes.ok) {
    throw new Error(`GitHub ref lookup failed (${refRes.status}): ${await refRes.text()}`);
  }
  const { object } = await refRes.json() as { object: { sha: string } };

  const createRes = await fetch(`https://api.github.com/repos/${repoPath}/git/refs`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: object.sha }),
  });
  if (!createRes.ok && createRes.status !== 422) {
    // 422 here means the ref already exists (race with another creator) - safe to ignore.
    throw new Error(`GitHub branch creation failed (${createRes.status}): ${await createRes.text()}`);
  }
}

export async function createGitHubPR(opts: {
  repoUrl: string;
  branch: string;
  title: string;
  body: string;
  token: string;
  base?: string;
}): Promise<PRResult> {
  const repoPath = parseRepoPath(opts.repoUrl);
  const base = opts.base ?? "main";

  await ensureGitHubBranchExists(repoPath, base, opts.token);

  const res = await fetch(`https://api.github.com/repos/${repoPath}/pulls`, {
    method: "POST",
    headers: {
      ...githubHeaders(opts.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      head: opts.branch,
      base,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR creation failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
}

/**
 * Look up an already-open PR whose head is `branch`. Used before creating a PR so a
 * retry (or an agent that opened one itself with `gh`) adopts the existing PR rather
 * than failing with GitHub's 422 "A pull request already exists".
 */
export async function findOpenGitHubPR(opts: { repoUrl: string; branch: string; token: string }): Promise<PRResult | null> {
  const repoPath = parseRepoPath(opts.repoUrl);
  const owner = repoPath.split("/")[0];
  const res = await fetch(
    `https://api.github.com/repos/${repoPath}/pulls?state=open&head=${encodeURIComponent(`${owner}:${opts.branch}`)}`,
    { headers: githubHeaders(opts.token) },
  );
  if (!res.ok) {
    throw new Error(`GitHub PR lookup failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as Array<{ html_url: string; number: number }>;
  return data.length > 0 ? { url: data[0].html_url, number: data[0].number } : null;
}

/** Extract the PR/MR number from a GitHub or GitLab web URL. */
export function parsePRNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/(?:pull|merge_requests)\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export async function getGitHubPRStatus(opts: {
  repoUrl: string;
  number: number;
  token: string;
}): Promise<{ merged: boolean; state: string; noChanges: boolean }> {
  const repoPath = parseRepoPath(opts.repoUrl);
  const res = await fetch(`https://api.github.com/repos/${repoPath}/pulls/${opts.number}`, {
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR status check failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { merged: boolean; state: string; additions?: number; deletions?: number; changed_files?: number };
  // additions/deletions/changed_files are all 0 when the branch has no diff
  // against the base — i.e. this is a "no change" PR with nothing to release.
  const noChanges = (data.additions ?? 0) === 0 && (data.deletions ?? 0) === 0 && (data.changed_files ?? 0) === 0;
  return { merged: data.merged, state: data.state, noChanges };
}

export async function getGitLabMRStatus(opts: {
  repoUrl: string;
  number: number;
  token: string;
  baseUrl: string;
}): Promise<{ merged: boolean; state: string; noChanges: boolean }> {
  const apiBase = opts.baseUrl.replace(/\/$/, "");
  const projectPath = encodeURIComponent(parseRepoPath(opts.repoUrl));
  const res = await fetch(`${apiBase}/api/v4/projects/${projectPath}/merge_requests/${opts.number}`, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab MR status check failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { state: string; changes_count?: string | null };
  // changes_count is a string like "0", "5", or "1000+" — "0" means an empty diff.
  const noChanges = data.changes_count === "0";
  return { merged: data.state === "merged", state: data.state, noChanges };
}

/** Post a comment on a GitHub PR (uses the "issues" comment endpoint — PRs are issues in the GitHub API). */
export async function createGitHubPRComment(opts: {
  repoUrl: string;
  number: number;
  body: string;
  token: string;
}): Promise<void> {
  const repoPath = parseRepoPath(opts.repoUrl);
  const res = await fetch(`https://api.github.com/repos/${repoPath}/issues/${opts.number}/comments`, {
    method: "POST",
    headers: { ...githubHeaders(opts.token), "Content-Type": "application/json" },
    body: JSON.stringify({ body: opts.body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR comment failed (${res.status}): ${text}`);
  }
}

/** Post a comment (note) on a GitLab merge request. */
export async function createGitLabMRComment(opts: {
  repoUrl: string;
  number: number;
  body: string;
  token: string;
  baseUrl: string;
}): Promise<void> {
  const apiBase = opts.baseUrl.replace(/\/$/, "");
  const projectPath = encodeURIComponent(parseRepoPath(opts.repoUrl));
  const res = await fetch(`${apiBase}/api/v4/projects/${projectPath}/merge_requests/${opts.number}/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body: opts.body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab MR comment failed (${res.status}): ${text}`);
  }
}

export type MergeableState = "mergeable" | "conflicting" | "unknown";
export type CiStatus = "passing" | "failing" | "pending" | "none";

export async function getGitHubMergeability(opts: {
  repoUrl: string;
  number: number;
  token: string;
}): Promise<{ mergeableState: MergeableState | null; ciStatus: CiStatus }> {
  const repoPath = parseRepoPath(opts.repoUrl);
  const res = await fetch(`https://api.github.com/repos/${repoPath}/pulls/${opts.number}`, {
    headers: githubHeaders(opts.token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR mergeability check failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { mergeable: boolean | null; mergeable_state: string; head: { sha: string } };
  // GitHub computes mergeability asynchronously and returns mergeable: null while
  // it's still recalculating (e.g. right after the base branch changes). Treat that
  // as "indeterminate" rather than "unknown" so callers don't overwrite a previously
  // known conflicting state with a transient null.
  const mergeableState: MergeableState | null =
    data.mergeable === false || data.mergeable_state === "dirty" ? "conflicting"
    : data.mergeable === true ? "mergeable"
    : data.mergeable === null ? null
    : "unknown";

  const checksRes = await fetch(`https://api.github.com/repos/${repoPath}/commits/${data.head.sha}/check-runs`, {
    headers: githubHeaders(opts.token),
  });
  let ciStatus: CiStatus = "none";
  if (checksRes.ok) {
    const checks = await checksRes.json() as { check_runs: Array<{ status: string; conclusion: string | null }> };
    if (checks.check_runs.length > 0) {
      if (checks.check_runs.some((c) => c.status !== "completed")) ciStatus = "pending";
      else if (checks.check_runs.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled")) ciStatus = "failing";
      else ciStatus = "passing";
    }
  }

  return { mergeableState, ciStatus };
}

export async function getGitLabMergeability(opts: {
  repoUrl: string;
  number: number;
  token: string;
  baseUrl: string;
}): Promise<{ mergeableState: MergeableState | null; ciStatus: CiStatus }> {
  const apiBase = opts.baseUrl.replace(/\/$/, "");
  const projectPath = encodeURIComponent(parseRepoPath(opts.repoUrl));
  const res = await fetch(`${apiBase}/api/v4/projects/${projectPath}/merge_requests/${opts.number}`, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab MR mergeability check failed (${res.status}): ${text}`);
  }
  const data = await res.json() as {
    merge_status: string;
    detailed_merge_status?: string;
    pipeline: { status: string } | null;
    head_pipeline?: { status: string } | null;
  };
  const status = data.detailed_merge_status ?? data.merge_status;
  // GitLab reports "checking"/"unchecked" while it's still computing mergeability
  // asynchronously — treat that as indeterminate rather than "unknown" so callers
  // don't overwrite a previously known conflicting state with a transient result.
  const mergeableState: MergeableState | null =
    status === "conflict" || status === "cannot_be_merged" ? "conflicting"
    : status === "mergeable" || status === "can_be_merged" ? "mergeable"
    : status === "checking" || status === "unchecked" ? null
    : "unknown";

  const pipeline = data.head_pipeline ?? data.pipeline;
  let ciStatus: CiStatus = "none";
  if (pipeline) {
    if (pipeline.status === "success") ciStatus = "passing";
    else if (pipeline.status === "failed" || pipeline.status === "canceled") ciStatus = "failing";
    else if (pipeline.status === "running" || pipeline.status === "pending" || pipeline.status === "created") ciStatus = "pending";
  }

  return { mergeableState, ciStatus };
}

async function ensureGitLabBranchExists(apiBase: string, projectPath: string, branch: string, token: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const existing = await fetch(`${apiBase}/api/v4/projects/${projectPath}/repository/branches/${encodeURIComponent(branch)}`, { headers });
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(`GitLab branch lookup failed (${existing.status}): ${await existing.text()}`);
  }

  const projectRes = await fetch(`${apiBase}/api/v4/projects/${projectPath}`, { headers });
  if (!projectRes.ok) {
    throw new Error(`GitLab project lookup failed (${projectRes.status}): ${await projectRes.text()}`);
  }
  const { default_branch: defaultBranch } = await projectRes.json() as { default_branch: string };

  const createRes = await fetch(`${apiBase}/api/v4/projects/${projectPath}/repository/branches`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ branch, ref: defaultBranch }),
  });
  if (!createRes.ok && createRes.status !== 400) {
    // 400 here typically means the branch already exists (race with another creator) - safe to ignore.
    throw new Error(`GitLab branch creation failed (${createRes.status}): ${await createRes.text()}`);
  }
}

export async function createGitLabMR(opts: {
  repoUrl: string;
  branch: string;
  title: string;
  body: string;
  token: string;
  baseUrl: string;
  base?: string;
}): Promise<PRResult> {
  const apiBase = opts.baseUrl.replace(/\/$/, "");
  const projectPath = encodeURIComponent(parseRepoPath(opts.repoUrl));
  await ensureGitLabBranchExists(apiBase, projectPath, opts.base ?? "main", opts.token);
  const res = await fetch(`${apiBase}/api/v4/projects/${projectPath}/merge_requests`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_branch: opts.branch,
      target_branch: opts.base ?? "main",
      title: opts.title,
      description: opts.body,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab MR creation failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { web_url: string; iid: number };
  return { url: data.web_url, number: data.iid };
}

/** GitLab counterpart of findOpenGitHubPR — an open MR whose source branch is `branch`. */
export async function findOpenGitLabMR(opts: { repoUrl: string; branch: string; token: string; baseUrl: string }): Promise<PRResult | null> {
  const apiBase = opts.baseUrl.replace(/\/$/, "");
  const projectPath = encodeURIComponent(parseRepoPath(opts.repoUrl));
  const res = await fetch(
    `${apiBase}/api/v4/projects/${projectPath}/merge_requests?state=opened&source_branch=${encodeURIComponent(opts.branch)}`,
    { headers: { Authorization: `Bearer ${opts.token}` } },
  );
  if (!res.ok) {
    throw new Error(`GitLab MR lookup failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as Array<{ web_url: string; iid: number }>;
  return data.length > 0 ? { url: data[0].web_url, number: data[0].iid } : null;
}
