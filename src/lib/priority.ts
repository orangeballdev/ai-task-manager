/**
 * Manual task priority, set via Advanced Options at task creation/edit time.
 * The worker's poll query sorts pending/paused/throttled tasks by priority
 * (desc) then position (asc) when picking the next task(s) to run — see
 * pickTasksToRun() in src/worker/index.ts. Position (drag order in the Kanban
 * "To Do" column) still breaks ties within the same priority level.
 */
export const PRIORITY_LEVELS = ["low", "normal", "high", "urgent"] as const;

export type TaskPriority = (typeof PRIORITY_LEVELS)[number];

export const DEFAULT_PRIORITY: TaskPriority = "normal";

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (PRIORITY_LEVELS as readonly string[]).includes(v);
}

export function normalizePriority(v: unknown): TaskPriority {
  return isTaskPriority(v) ? v : DEFAULT_PRIORITY;
}

export function priorityWeight(v: string | null | undefined): number {
  return PRIORITY_WEIGHT[normalizePriority(v)];
}

/**
 * Sort comparator mirroring the worker's pick-up order: higher priority first,
 * then lower position (earlier in the queue) first.
 */
export function comparePriorityThenPosition(
  a: { priority?: string | null; position: number },
  b: { priority?: string | null; position: number }
): number {
  const diff = priorityWeight(b.priority) - priorityWeight(a.priority);
  if (diff !== 0) return diff;
  return a.position - b.position;
}
