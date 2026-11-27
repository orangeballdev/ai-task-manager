/**
 * Whether the worker should treat this run as a resume of prior work (reuse the existing
 * on-disk workspace/branch) rather than a fresh clone.
 *
 * Two independent counters drive this:
 * - `retryCount` — bumped by actual failure retries (manual Retry, bulk-retry,
 *   rate-limit auto-retry, rebase-branch, request-change).
 * - `reviewIterationCount` — bumped only by "Review PR" self-review re-runs (see
 *   src/app/api/tasks/[id]/review-pr/route.ts). Kept separate from retryCount because a
 *   review iteration isn't a failure, but the worker still needs to resume on the
 *   existing branch either way.
 */
export function shouldResumeTask(task: { retryCount: number; reviewIterationCount?: number | null }): boolean {
  return task.retryCount > 0 || (task.reviewIterationCount ?? 0) > 0;
}
