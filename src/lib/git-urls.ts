/**
 * Pure URL-construction helpers for linking to git providers.
 * Safe to import in both server and client components (no side effects).
 */

/** Catch-all scope for knowledge/settings that aren't tied to a single repo. */
export const GENERAL_SCOPE = "general";

/**
 * Normalize a git remote URL or arbitrary scope string to a stable scope key.
 *
 * Strips protocols, credentials, trailing .git, and lowercases the host so that
 * `https://github.com/acme/Foo.git`, `git@github.com:acme/Foo.git`, and
 * `github.com/acme/foo` all map to the same scope `github.com/acme/foo`.
 *
 * Empty / nullish input returns the literal "general" scope.
 */
export function normalizeScope(input: string | null | undefined): string {
  if (!input) return GENERAL_SCOPE;
  let s = String(input).trim();
  if (!s) return GENERAL_SCOPE;
  if (s.toLowerCase() === GENERAL_SCOPE) return GENERAL_SCOPE;

  // SSH form: git@github.com:acme/foo.git -> github.com/acme/foo
  const sshMatch = s.match(/^[^@\s]+@([^:]+):(.+)$/);
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // https://user:pw@github.com/acme/foo.git -> github.com/acme/foo
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    s = s.replace(/^[^@/]*@/, "");
  }
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/g, "");
  // Lowercase the host portion only (first segment before first slash)
  const slash = s.indexOf("/");
  if (slash > 0) {
    s = s.slice(0, slash).toLowerCase() + s.slice(slash);
  } else {
    s = s.toLowerCase();
  }
  return s || GENERAL_SCOPE;
}

function normaliseRepoUrl(repoUrl: string): URL | null {
  try {
    let url = repoUrl.trim();
    if (url.startsWith("git@")) {
      url = url.replace(/^git@([^:]+):/, "https://$1/");
    }
    url = url.replace(/\.git$/, "");
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Short, readable form of a clone URL — drops the protocol / scp-style user
 * prefix and the `.git` suffix so `host/owner/name` stays legible on a narrow
 * phone screen instead of being truncated away.
 */
export function shortRepoUrl(url: string): string {
  const raw = url.trim().replace(/\/+$/, "");
  let out: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // https://user@host/owner/name.git -> host/owner/name
    out = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/@]+@/, "");
  } else {
    // scp-style: git@host:owner/name.git -> host/owner/name
    const scp = raw.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/);
    out = scp ? `${scp[1]}/${scp[2]}` : raw;
  }
  return out.replace(/\.git$/i, "") || raw;
}

export function getCommitUrl(repoUrl: string, sha: string): string | null {
  const parsed = normaliseRepoUrl(repoUrl);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (host === "github.com" || host.endsWith(".github.com")) {
    return `${base}/commit/${sha}`;
  } else if (host.includes("gitlab")) {
    return `${base}/-/commit/${sha}`;
  } else if (host === "bitbucket.org") {
    return `${base}/commits/${sha}`;
  }
  return null;
}

export function getBranchUrl(repoUrl: string, branch: string): string | null {
  const parsed = normaliseRepoUrl(repoUrl);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (host === "github.com" || host.endsWith(".github.com")) {
    return `${base}/tree/${branch}`;
  } else if (host.includes("gitlab")) {
    return `${base}/-/tree/${branch}`;
  } else if (host === "bitbucket.org") {
    return `${base}/branch/${branch}`;
  }
  return `${base}/src/branch/${branch}`;
}

export function getCompareUrl(repoUrl: string, branch: string): string | null {
  const parsed = normaliseRepoUrl(repoUrl);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (host === "github.com" || host.endsWith(".github.com")) {
    return `${base}/compare/${branch}`;
  } else if (host.includes("gitlab")) {
    return `${base}/-/compare/main...${branch}`;
  }
  return null;
}

/**
 * Build a copy-pasteable shell command to fetch and check out a task's branch
 * for a single repo, e.g. for reviewing the agent's work locally.
 */
export function getCheckoutCommand(branch: string): string {
  return `git fetch origin ${branch} && git checkout ${branch}`;
}

/** Parse the JSON commitSha field from a task into a { alias → sha } map. */
export function parseCommitShas(commitSha: string | null | undefined): Record<string, string> {
  if (!commitSha) return {};
  try {
    return JSON.parse(commitSha) as Record<string, string>;
  } catch {
    return {};
  }
}

export interface TaskPRInfo {
  url: string;
  number: number;
  /** Set once this specific PR has been confirmed merged, so re-sync can skip re-checking it. */
  merged?: boolean;
}

/**
 * Parse the JSON prUrls field from a task into a { repo alias → PR info } map.
 * A task with multiple repos creates one PR per repo (see worker/index.ts), so this map
 * — not the single legacy prUrl/prNumber fields — is the source of truth for "are all of
 * this task's PRs merged yet", and lets the UI link to every repo's PR instead of just
 * the last one created.
 */
export function parsePRUrls(prUrls: string | null | undefined): Record<string, TaskPRInfo> {
  if (!prUrls) return {};
  try {
    return JSON.parse(prUrls) as Record<string, TaskPRInfo>;
  } catch {
    return {};
  }
}
