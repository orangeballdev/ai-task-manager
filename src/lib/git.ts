import { simpleGit, type SimpleGit } from "simple-git";
import { isGuardedEnvKey } from "@simple-git/argv-parser";
import fs from "fs/promises";
import { getRepoDest, ensureWorkspace } from "./workspace";
import { buildChangesSummary } from "./changes-summary";
import { loadGitCredentials, injectToken, type GitCredentials } from "./git-auth";

export function branchName(taskId: string, slug: string): string {
  return `agent/${taskId.slice(0, 8)}-${slug}`;
}

export function safeEnv(extra?: Record<string, string>): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // simple-git 4 rejects any call whose `.env()` carries a guarded variable (every
  // GIT_* key plus editor/pager/askpass-style ones) unless it's in `allowEnvironment`.
  // We pass the whole environment, so drop every guarded key inherited from the host;
  // the ones we set on purpose (GIT_SSH_COMMAND) come in through `extra` and must be
  // allowed by the caller (see SSH_COMMAND_ENV).
  for (const key of Object.keys(env)) {
    if (isGuardedEnvKey(key.toLowerCase())) delete env[key];
  }
  delete env.SSH_ASKPASS;
  return extra ? { ...env, ...extra } : env;
}

/** simple-git options for an instance whose env carries our own GIT_SSH_COMMAND. */
const SSH_COMMAND_ENV = { unsafe: { allowUnsafeSshCommand: true }, allowEnvironment: ["GIT_SSH_COMMAND"] } as const;

/** Config keys we write ourselves that aren't on simple-git's known-safe list (widening the refspec of a --branch clone). */
const WORKSPACE_CONFIG = { allowConfig: ["remote.origin.fetch"] } as const;

export async function cloneRepo(
  url: string,
  taskId: string,
  alias: string,
  branch?: string,
  /**
   * Branch to start from when `branch` doesn't exist on origin (e.g. the task's base
   * branch when resuming an agent branch that was never pushed). Without it the clone
   * falls back to origin's default branch, which may not be the branch the PR targets.
   */
  fallbackBranch?: string
): Promise<SimpleGit> {
  await ensureWorkspace(taskId);
  const dest = getRepoDest(taskId, alias);

  // Remove stale destination from a previous attempt before re-cloning
  await fs.rm(dest, { recursive: true, force: true });

  const creds = await loadGitCredentials();
  const branchArgs = branch ? ["--depth", "1", "--branch", branch] : ["--depth", "1"];
  const defaultArgs = ["--depth", "1"];

  async function doClone(args: string[]) {
    if (url.startsWith("https://") && creds.token) {
      await simpleGit().env(safeEnv()).clone(injectToken(url, creds.token), dest, args);
    } else if (url.startsWith("git@")) {
      const sshCommand = creds.sshKeyPath
        ? `ssh -i ${creds.sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`
        : `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
      const sshGit = simpleGit({ config: [`core.sshCommand=${sshCommand}`], unsafe: { allowUnsafeSshCommand: true } });
      await sshGit.env(safeEnv()).clone(url, dest, args);
    } else {
      await simpleGit().env(safeEnv()).clone(url, dest, args);
    }
  }

  let branchCreated = false;
  try {
    await doClone(branchArgs);
  } catch (err) {
    if (branch) {
      // Branch likely doesn't exist on remote — clone the fallback (or default) branch
      // and create it locally
      await fs.rm(dest, { recursive: true, force: true });
      let clonedFallback = false;
      if (fallbackBranch && fallbackBranch !== branch) {
        try {
          await doClone(["--depth", "1", "--branch", fallbackBranch]);
          clonedFallback = true;
        } catch {
          await fs.rm(dest, { recursive: true, force: true });
        }
      }
      if (!clonedFallback) await doClone(defaultArgs);
      branchCreated = true;
    } else {
      throw err;
    }
  }

  const git = simpleGit(dest, { unsafe: { allowUnsafeSshCommand: true }, ...WORKSPACE_CONFIG }).env(safeEnv());
  if (creds.userName) await git.addConfig("user.name", creds.userName);
  if (creds.userEmail) await git.addConfig("user.email", creds.userEmail);

  // A `--branch <branch>` clone narrows remote.origin.fetch to just that one branch,
  // so a later `git fetch origin <otherBranch>` (e.g. rebasing onto a base branch)
  // only populates FETCH_HEAD, never creating an origin/<otherBranch> ref to rebase
  // onto. Widen it so any branch fetched afterward becomes a normal remote-tracking ref.
  await git.raw(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);

  // Persist the SSH host-key bypass into this repo's local .git/config so that any
  // git command run later in this workspace (e.g. by the spawned `claude` CLI's own
  // Bash tool calls) also uses it, not just the worker's own simple-git calls.
  if (url.startsWith("git@")) {
    const sshCommand = creds.sshKeyPath
      ? `ssh -i ${creds.sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`
      : `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    await git.addConfig("core.sshCommand", sshCommand);
  }

  if (branchCreated && branch) {
    await git.checkoutLocalBranch(branch);
  }

  return git;
}

export async function createAndCheckoutBranch(
  git: SimpleGit,
  branch: string
): Promise<void> {
  await git.checkoutLocalBranch(branch);
}

export interface CommitResult {
  sha?: string;
  // True when the working tree was still dirty at this point and got committed here.
  // False only means *this* commit step found nothing uncommitted — it does NOT mean
  // the run made no changes overall, since the agent may have already committed its
  // own work earlier (the system prompt tells it to commit as it goes). Callers should
  // combine this with resolveRepoHadChanges() below rather than treating it alone as
  // "no changes were made".
  hadChanges: boolean;
}

export async function commitAll(
  git: SimpleGit,
  message: string,
  identity?: { userName?: string; userEmail?: string }
): Promise<CommitResult> {
  if (identity?.userName) await git.addConfig("user.name", identity.userName);
  if (identity?.userEmail) await git.addConfig("user.email", identity.userEmail);
  await git.add(".");
  const status = await git.status();
  if (!status.isClean()) {
    const result = await git.commit(message);
    return { sha: result.commit || undefined, hadChanges: true };
  }
  // Return the current HEAD SHA even if there was nothing new to commit
  try {
    const sha = await git.revparse(["HEAD"]);
    return { sha: sha.trim() || undefined, hadChanges: false };
  } catch {
    return { hadChanges: false };
  }
}

// Whether a repo actually has commits worth pushing/PR-ing for this task run.
//
// commitAll()'s own hadChanges only reflects whether *its* final commit step found a
// dirty working tree. That misses the common case where the agent already committed
// its own work mid-run (CODING_SYSTEM_PROMPT tells it to "commit your changes
// regularly... but do NOT push") — by the time commitAll runs, the tree is clean, so
// it reports hadChanges: false even though the branch has real commits ahead of where
// it started. That false negative was causing tasks to push a branch with real changes
// but land on "no_changes" status and skip PR creation entirely.
//
// This combines commitAll's dirty-tree signal with a comparison of HEAD before/after
// the agent ran, so either "something was dirty at commit time" or "HEAD moved since
// the run started" counts as a real change.
//
// A brand-new, empty repo has no baseline commit at all: origin has no branches and
// the local clone's HEAD is unborn. That is recorded as EMPTY_REPO_BASELINE rather than
// left undefined (= "couldn't capture a baseline"), so any commit the agent made counts
// — otherwise a task that created a repo's very first commits was pushed but reported
// as "no changes".
export const EMPTY_REPO_BASELINE = "";

export function resolveRepoHadChanges(
  dirtyTreeHadChanges: boolean,
  baseHeadSha: string | undefined,
  headShaAfterCommit: string | undefined
): boolean {
  if (dirtyTreeHadChanges) return true;
  if (!headShaAfterCommit) return false;
  if (baseHeadSha === EMPTY_REPO_BASELINE) return true;
  return !!baseHeadSha && headShaAfterCommit !== baseHeadSha;
}

/**
 * The branch name origin's HEAD points at, from `git ls-remote --symref origin HEAD`
 * output (`ref: refs/heads/main\tHEAD`), or null when it isn't there.
 */
export function parseRemoteDefaultBranch(lsRemoteSymrefOutput: string): string | null {
  const m = lsRemoteSymrefOutput.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD\s*$/m);
  return m ? m[1] : null;
}

/**
 * The base branch to actually use for a repo: `preferred` (a per-repo branch or the global
 * Settings > Git default) when origin has it, otherwise origin's default branch. The global
 * default is shared by every repo, so it is routinely wrong for some of them (`develop` on a
 * repo that only has `main`). cloneRepo() already falls back like this; the baseline, the
 * commits-ahead check and the PR base must agree with it, or a run that clearly committed
 * work is reported as "no changes" and never gets its PR. Returns `preferred` unchanged when
 * origin can't be asked.
 */
export async function resolveBaseBranch(git: SimpleGit, preferred: string): Promise<string> {
  try {
    const heads = await git.raw(["ls-remote", "--heads", "origin", preferred]);
    // ls-remote patterns match on path suffix too (`feature/develop`), so check exactly.
    if (heads.split("\n").some((line) => line.trim().endsWith(`\trefs/heads/${preferred}`))) return preferred;
    const symref = await git.raw(["ls-remote", "--symref", "origin", "HEAD"]);
    return parseRemoteDefaultBranch(symref) ?? preferred;
  } catch {
    return preferred;
  }
}

/**
 * How many commits `HEAD` is ahead of `origin/<baseBranch>`, or null when that can't be
 * determined (base branch missing on origin, fetch failed, …). Unlike the baseline-sha
 * comparison in resolveRepoHadChanges, this also sees work that an *earlier* run of the
 * same task already pushed — e.g. a run that pushed its branch but then failed to open
 * the PR. That is what lets a retry still open the PR instead of reporting "no changes".
 */
export async function countCommitsAheadOfBase(git: SimpleGit, baseBranch: string): Promise<number | null> {
  try {
    await git.fetch("origin", baseBranch);
    const out = await git.raw(["rev-list", "--count", "FETCH_HEAD..HEAD"]);
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Confirm `branch` on origin now points at the local HEAD. A push that "succeeded"
 * without actually updating the remote (hooks, a rejected ref swallowed by a retry,
 * the agent switching remotes) would otherwise let the task complete with its work
 * only on the worker's disk. Throws with a descriptive message on mismatch.
 */
export async function verifyBranchPushed(repoPath: string, branch: string, creds?: GitCredentials): Promise<string> {
  const sshCmd = creds?.sshKeyPath
    ? `ssh -i ${creds.sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`
    : undefined;
  const git = sshCmd
    ? simpleGit(repoPath, SSH_COMMAND_ENV).env(safeEnv({ GIT_SSH_COMMAND: sshCmd }))
    : simpleGit(repoPath).env(safeEnv());
  const localSha = (await git.revparse(["HEAD"])).trim();
  const remote = await git.raw(["ls-remote", "--heads", "origin", branch]);
  const remoteSha = remote.trim().split(/\s+/)[0] || "";
  if (!remoteSha) {
    throw new Error(`push verification failed: branch '${branch}' does not exist on origin after push`);
  }
  if (remoteSha !== localSha) {
    // On a shared branch (push-to-main / target branch) someone else may have pushed on
    // top of us in the meantime — that's fine as long as our commit is in the remote's history.
    const containsOurs = await git.fetch("origin", branch)
      .then(() => git.raw(["merge-base", "--is-ancestor", localSha, "FETCH_HEAD"]))
      .then(() => true, () => false);
    if (containsOurs) return localSha;
    throw new Error(`push verification failed: origin/${branch} is at ${remoteSha.slice(0, 7)} but local HEAD is ${localSha.slice(0, 7)}`);
  }
  return localSha;
}

export async function pushBranch(repoPath: string, branch: string, creds?: GitCredentials, noForce = false): Promise<void> {
  const sshCmd = creds?.sshKeyPath
    ? `ssh -i ${creds.sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`
    : undefined;
  const git = sshCmd
    ? simpleGit(repoPath, SSH_COMMAND_ENV).env(safeEnv({ GIT_SSH_COMMAND: sshCmd }))
    : simpleGit(repoPath).env(safeEnv());
  if (noForce) {
    // Only pull if the branch already exists on the remote; skip pull for new branches
    const remoteRef = await git.raw(["ls-remote", "--heads", "origin", branch]).catch(() => "");
    if (remoteRef.trim()) {
      await git.pull("origin", branch, ["--rebase", "-X", "theirs"]);
    }
  }
  const flags = noForce ? ["--set-upstream"] : ["--set-upstream", "--force"];
  try {
    await git.push("origin", branch, flags);
  } catch (pushErr) {
    const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    // If origin moved ahead between our pull and push, fetch, rebase, and retry once
    if (noForce && (pushMsg.includes("non-fast-forward") || pushMsg.includes("rejected"))) {
      await git.fetch("origin");
      try {
        await git.pull("origin", branch, ["--rebase", "-X", "theirs"]);
      } catch {
        await git.raw(["rebase", "--abort"]).catch(() => {});
        throw pushErr;
      }
      await git.push("origin", branch, ["--set-upstream"]);
    } else {
      throw pushErr;
    }
  }
}

export async function openRepo(repoDest: string, url?: string): Promise<SimpleGit> {
  const creds = await loadGitCredentials();
  let git: SimpleGit;
  if (url?.startsWith("git@") && creds.sshKeyPath) {
    const sshCommand = `ssh -i ${creds.sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    git = simpleGit(repoDest, { ...SSH_COMMAND_ENV, ...WORKSPACE_CONFIG })
      .env(safeEnv({ GIT_SSH_COMMAND: sshCommand }));
  } else {
    git = simpleGit(repoDest, WORKSPACE_CONFIG).env(safeEnv());
  }
  if (creds.userName) await git.addConfig("user.name", creds.userName);
  if (creds.userEmail) await git.addConfig("user.email", creds.userEmail);
  return git;
}

// Pulls the latest remote changes into an existing working repo before resuming a paused task.
// Commits any uncommitted agent work first, then rebases on the remote branch.
// In rebase mode, "-X theirs" keeps the local/agent branch's version on conflicts.
/**
 * Bring a resumed workspace's agent branch up to date with the latest `origin/<baseBranch>`
 * by rebasing onto it. A task can sit in the backlog (or be retried) long after its
 * workspace was first cloned; without this the agent keeps building on a stale snapshot
 * of the base branch and the resulting PR conflicts with everything merged since.
 *
 * Never leaves a rebase in flight: on conflicts it aborts and reports `hadConflicts` so
 * the caller can tell the agent, leaving the branch exactly as it was. Agent branches are
 * force-pushed, so rewriting already-pushed commits here is safe.
 */
export async function syncWithBaseBranch(
  git: SimpleGit,
  baseBranch: string
): Promise<{ updated: boolean; hadConflicts: boolean; message: string }> {
  try {
    await git.raw(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  } catch { /* ignore — the fetch below surfaces any real problem */ }

  try {
    await git.fetch("origin", baseBranch);
  } catch {
    return { updated: false, hadConflicts: false, message: `Could not fetch origin/${baseBranch}; continuing on the existing base` };
  }

  const baseRef = `origin/${baseBranch}`;
  // Commits on the base branch that HEAD doesn't have yet. (Not `merge-base --is-ancestor`:
  // it answers only through its exit code, which simple-git's raw() doesn't surface.)
  const behind = parseInt((await git.raw(["rev-list", "--count", `HEAD..${baseRef}`]).catch(() => "")).trim(), 10);
  if (behind === 0) {
    return { updated: false, hadConflicts: false, message: `Already up to date with ${baseRef}` };
  }

  // Workspaces are shallow clones. If the agent branch's history doesn't connect to the
  // base branch's, a rebase would replay the whole shallow root as one giant commit —
  // deepen first, and give up rather than rebase without a real merge base.
  const hasMergeBase = async () => (await git.raw(["merge-base", baseRef, "HEAD"]).catch(() => "")).trim() !== "";
  if (!(await hasMergeBase())) {
    await git.raw(["fetch", "--unshallow", "origin"]).catch(() => undefined);
    if (!(await hasMergeBase())) {
      return { updated: false, hadConflicts: false, message: `Could not find a common ancestor with ${baseRef}; continuing on the existing base` };
    }
  }

  try {
    await git.rebase([baseRef]);
    return { updated: true, hadConflicts: false, message: `Rebased onto latest ${baseRef}` };
  } catch {
    try { await git.raw(["rebase", "--abort"]); } catch { /* ignore */ }
    return { updated: false, hadConflicts: true, message: `Rebasing onto latest ${baseRef} hit conflicts; left the branch on its previous base` };
  }
}

export async function pullAndSyncWorkingRepo(
  git: SimpleGit,
  branch: string,
  /**
   * The branch the task's PR targets. When given (and different from `branch`), the
   * agent branch is also rebased onto its latest commit — see syncWithBaseBranch().
   * Omit for tasks that work directly on an existing branch.
   */
  baseBranch?: string
): Promise<{ pulled: boolean; hadConflicts: boolean; baseConflict?: boolean; message: string }> {
  const result = await pullOwnBranch(git, branch, baseBranch);
  if (!baseBranch || baseBranch === branch || result.hadConflicts) return result;
  const base = await syncWithBaseBranch(git, baseBranch);
  return {
    pulled: result.pulled || base.updated,
    hadConflicts: false,
    baseConflict: base.hadConflicts,
    message: `${result.message}; ${base.message}`,
  };
}

async function pullOwnBranch(
  git: SimpleGit,
  branch: string,
  baseBranch?: string
): Promise<{ pulled: boolean; hadConflicts: boolean; message: string }> {
  try {
    const status = await git.status();
    if (!status.isClean()) {
      await git.add(".");
      try {
        await git.commit("agent: checkpoint before resume sync");
      } catch {
        // Nothing to commit (e.g., only untracked deletions) — skip
      }
    }

    try {
      await git.fetch("origin");
    } catch {
      return { pulled: false, hadConflicts: false, message: "Could not fetch from origin; continuing with existing state" };
    }

    const remoteRef = await git.raw(["ls-remote", "--heads", "origin", branch]);
    if (!remoteRef.trim()) {
      // Branch not pushed yet. With a known base branch the caller rebases onto it next.
      if (baseBranch) {
        return { pulled: false, hadConflicts: false, message: `origin/${branch} not pushed yet` };
      }
      // Otherwise rebase on the upstream default branch to get latest code
      let defaultBranch = "main";
      try {
        const remoteShow = await git.remote(["show", "origin"]);
        const match = remoteShow?.match(/HEAD branch:\s*(\S+)/);
        if (match) defaultBranch = match[1];
      } catch { /* use default */ }

      try {
        // "-X theirs" in rebase context keeps the local (agent) branch version on conflicts
        await git.rebase([`origin/${defaultBranch}`, "-X", "theirs"]);
        return { pulled: true, hadConflicts: false, message: `Rebased on origin/${defaultBranch} to incorporate latest changes` };
      } catch {
        try { await git.raw(["rebase", "--abort"]); } catch { /* ignore */ }
        return { pulled: false, hadConflicts: false, message: `Could not rebase on origin/${defaultBranch}; continuing with existing state` };
      }
    }

    // Branch exists on remote — pull with rebase, keeping agent's local changes on conflict
    try {
      await git.pull("origin", branch, ["--rebase", "-X", "theirs"]);
      return { pulled: true, hadConflicts: false, message: `Pulled latest from origin/${branch}` };
    } catch {
      try { await git.raw(["rebase", "--abort"]); } catch { /* ignore */ }
      // Fallback: merge, preferring local (agent) changes on conflict
      try {
        await git.merge([`origin/${branch}`, "-X", "ours"]);
        return { pulled: true, hadConflicts: true, message: `Merged origin/${branch} (conflicts resolved keeping agent changes)` };
      } catch {
        try { await git.raw(["merge", "--abort"]); } catch { /* ignore */ }
        return { pulled: false, hadConflicts: true, message: "Could not sync with remote; continuing with existing state" };
      }
    }
  } catch (err) {
    return { pulled: false, hadConflicts: false, message: `Sync error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Detects a repo's upstream default branch (e.g. "main"/"master") from an existing
// on-disk clone. Falls back to "main" if detection fails (remote not configured, etc).
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const git = simpleGit(repoPath).env(safeEnv());
    await git.fetch("origin");
    const remoteInfo = await git.remote(["show", "origin"]);
    const match = remoteInfo?.match(/HEAD branch:\s*(\S+)/);
    if (match) return match[1];
  } catch { /* fall through to default */ }
  return "main";
}

// Worker-side rebase onto a base branch (e.g. develop/main) before spawning the agent.
// Returns whether the rebase was clean, left conflicts, or couldn't be attempted.
export async function rebaseOntoBase(
  git: SimpleGit,
  baseBranch: string
): Promise<{ clean: boolean; hadConflicts: boolean; message: string }> {
  // Ensure wide refspec so the fetch creates a proper origin/<branch> tracking ref.
  // Workspaces cloned with --depth 1 --branch <x> get a narrow refspec by default;
  // without this, `git fetch origin develop` only updates FETCH_HEAD and
  // `git rebase origin/develop` then fails with "ref not found".
  try {
    await git.raw(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  } catch { /* ignore — rebase attempt below will surface any real problem */ }

  try {
    await git.fetch("origin", baseBranch);
  } catch {
    return { clean: false, hadConflicts: false, message: `Could not fetch origin/${baseBranch}, agent will need credentials to rebase` };
  }

  try {
    await git.rebase([`origin/${baseBranch}`]);
    return { clean: true, hadConflicts: false, message: `Rebased onto origin/${baseBranch}` };
  } catch {
    // Leave rebase in-flight so the agent can resolve conflicts with git add + git rebase --continue
    return { clean: false, hadConflicts: true, message: `Rebase onto origin/${baseBranch} has conflicts, agent will resolve them` };
  }
}

export async function generatePRSummary(
  taskTitle: string,
  branch: string,
  isPR = true
): Promise<string> {
  return buildChangesSummary(taskTitle, branch, isPR);
}
