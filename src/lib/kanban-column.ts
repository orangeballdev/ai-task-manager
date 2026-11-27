import { parsePRUrls } from "./git-urls";
import type { Task } from "./types";

export type ColumnKey = "todo" | "in_progress" | "in_review" | "done";

/** True when the task has at least one PR/MR attached that pr-sync hasn't confirmed merged. */
function hasOpenPR(task: Pick<Task, "prUrl" | "prUrls">): boolean {
  return Boolean(task.prUrl) || Object.keys(parsePRUrls(task.prUrls)).length > 0;
}

/**
 * Derives the Kanban column a task belongs on from its worker-owned `status` and the
 * one piece of board state this app owns, `reviewStatus` (see the "Only the In Review
 * <-> Done transition is user-editable" note in KanbanBoard.tsx).
 */
/**
 * A `no_changes` task with no open PR has nothing to review: its most recent run made
 * no diff and there's no PR waiting on a human. Such a task never belongs in In Review —
 * not even when a stale `reviewStatus: "in_review"` survives from an earlier run that
 * did make changes (retries keep reviewStatus), or when someone tries to reopen it.
 */
export function hasNothingToReview(task: Pick<Task, "status" | "prUrl" | "prUrls">): boolean {
  return task.status === "no_changes" && !hasOpenPR(task);
}

export function columnFor(task: Task): ColumnKey | null {
  if (task.reviewStatus === "done") return "done";
  // No-change runs with no open PR go straight to Done and stay there — this has to be
  // checked before the manual reviewStatus override below, otherwise a retried task
  // whose earlier run was put In Review keeps showing up there with nothing to review.
  if (hasNothingToReview(task)) return "done";
  // A user dragging a Done card back into In Review (reopening it) must win even when the
  // status-based rules below would otherwise send it back to Done.
  if (task.reviewStatus === "in_review") return "in_review";
  // For a "Review PR" self-review re-run (see review-pr route) that finds nothing to
  // change, the task's *existing* PR is still open and unreviewed by a human — that
  // "no changes requested" outcome must land back in In Review, not Done, since the PR
  // itself hasn't been merged/closed yet. (No-PR no_changes tasks are handled above.)
  if (task.status === "no_changes") return "in_review";
  if (task.status === "completed") return "in_review";
  if (task.status === "running" || task.status === "paused") return "in_progress";
  // A team pipeline waiting for a human to approve a stage is mid-flight, not done.
  if (task.status === "awaiting_approval") return "in_progress";
  // Throttled tasks sit in To Do so they can be dragged to In Progress to resume.
  // Failed/killed/timedout also stay visible in To Do for re-running.
  return "todo";
}

/**
 * True when the task is a To Do card the user has hidden from the board ("not now"
 * work they don't want cluttering the column). Hiding only applies to To Do: once a
 * hidden task starts running or finishes it shows up again in its new column, so
 * nothing in flight or awaiting review can disappear. Display only — the worker
 * ignores `hiddenOnBoard`.
 */
export function isHiddenOnBoard(task: Task): boolean {
  return Boolean(task.hiddenOnBoard) && columnFor(task) === "todo";
}

/** Drops hidden To Do cards unless the board is set to show them. */
export function visibleOnBoard(tasks: Task[], showHidden: boolean): Task[] {
  return showHidden ? tasks : tasks.filter((t) => !isHiddenOnBoard(t));
}
