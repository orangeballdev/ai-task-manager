import { columnFor } from "./kanban-column";
import type { Task } from "./types";

/** Task statuses automatic cleanup considers "finished". */
export const TERMINAL_STATUSES = ["completed", "no_changes", "failed", "killed", "timedout"];

/**
 * Which tasks automatic cleanup may delete (`task_retention_scope` setting):
 * - "all"  — every finished task (completed, no changes, failed, killed, timed out)
 * - "done" — only tasks in the board's Done column; tasks still In Review, and
 *            failed/killed/timed-out tasks waiting in To Do, are left alone.
 */
export type TaskRetentionScope = "all" | "done";

export function parseRetentionScope(value: string | null | undefined): TaskRetentionScope {
  return value === "done" ? "done" : "all";
}

export interface TaskCleanupCandidate {
  id: string;
  status: string;
  reviewStatus: string | null;
  prUrl: string | null;
  prUrls: string | null;
}

/** Filters already-expired terminal tasks down to the ones the retention scope allows deleting. */
export function selectTasksForCleanup(tasks: TaskCleanupCandidate[], scope: TaskRetentionScope): string[] {
  return tasks
    .filter((t) => TERMINAL_STATUSES.includes(t.status))
    .filter((t) => scope === "all" || columnFor(t as unknown as Task) === "done")
    .map((t) => t.id);
}
