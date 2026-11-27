/**
 * Pure decision for the worker's "open a PR for this repo?" step (see runTask() in
 * src/worker/index.ts). Kept free of I/O so every branch is unit-tested — the previous
 * inline condition silently skipped PR creation in several cases where the user had
 * asked for one (no token configured, a retry whose commits were already pushed by the
 * earlier run, a baseline snapshot that failed), letting the task finish as
 * "completed"/"no_changes" with no PR and no error.
 */

export interface PrDecisionInput {
  /** The task asked for a PR (`Task.createPR`). */
  createPR: boolean;
  /** The task pushes straight to an existing branch / main — PRs don't apply. */
  workOnExistingBranch: boolean;
  /** A git access token is configured (needed to call the GitHub/GitLab API). */
  hasToken: boolean;
  /** This run committed something (dirty tree at commit time, or HEAD moved since the baseline). */
  hadChanges: boolean;
  /**
   * Commits the pushed branch is ahead of the PR base branch on origin, or null when that
   * couldn't be determined. Catches work pushed by an earlier run of the same task.
   */
  commitsAheadOfBase: number | null;
}

export type PrDecision =
  /** Not requested / not applicable — nothing to do, not an error. */
  | { action: "skip"; reason: string }
  /** Requested, but the branch carries no commits relative to its base. */
  | { action: "no_changes" }
  /** Requested and the branch has work — open (or adopt an existing) PR. */
  | { action: "create" }
  /** Requested and the branch has work, but a PR can't be opened. The task must not pass as a success. */
  | { action: "error"; reason: string };

export function decidePrAction(input: PrDecisionInput): PrDecision {
  if (!input.createPR) return { action: "skip", reason: "PR creation not requested for this task" };
  if (input.workOnExistingBranch) {
    return { action: "skip", reason: "task pushes directly to an existing branch, no PR is opened" };
  }
  // The base comparison is authoritative when we have it: a branch with zero commits
  // ahead of base can't have a PR opened (GitHub/GitLab reject an empty diff), even if
  // this run made and then reverted a commit.
  const branchHasWork = input.commitsAheadOfBase !== null
    ? input.commitsAheadOfBase > 0
    : input.hadChanges;
  if (!branchHasWork) return { action: "no_changes" };
  if (!input.hasToken) {
    return {
      action: "error",
      reason: "a pull request was requested but no git access token is configured (Settings > Git), so it could not be opened",
    };
  }
  return { action: "create" };
}
