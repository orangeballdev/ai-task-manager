/**
 * Which kind of message a task accepts, keyed off its status. Mirrors the branches of
 * `POST /api/tasks/[id]/message`.
 *
 * This lives in a plain (non-"use client") module on purpose: the task detail page is a
 * server component and needs `canMessageTask()` to decide whether to render the composer.
 * Exporting it from the `"use client"` `TaskComposer` module turned it into a client
 * reference, and calling that from the server threw at render time, which made
 * `/tasks/[id]` return a 500 for every non-template task.
 */

const TERMINAL_STATUSES = new Set(["completed", "no_changes", "failed", "killed", "timedout"]);

/** `live`: guidance to a running agent; `held`: added to context of a paused/throttled task; `followup`: re-queues a finished task. */
export type TaskMessageMode = "live" | "held" | "followup";

export function taskMessageMode(status: string): TaskMessageMode | null {
  if (status === "running") return "live";
  if (status === "paused" || status === "throttled" || status === "awaiting_approval") return "held";
  if (TERMINAL_STATUSES.has(status)) return "followup";
  return null;
}

/** Whether the task is in a state that `POST /api/tasks/[id]/message` accepts. */
export function canMessageTask(status: string): boolean {
  return taskMessageMode(status) !== null;
}
