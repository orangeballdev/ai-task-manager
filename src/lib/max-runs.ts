/**
 * Helpers for the recurring-task "max runs" cap.
 *
 * A recurring template stores `maxRuns` (how many times the cron schedule may fire) and
 * `runCount` (how many times it already has). `maxRuns === null` means unlimited, which is
 * the default for every task — so anything that isn't a usable positive integer normalizes
 * back to null rather than accidentally capping a schedule at 0 runs.
 */

/** Upper bound so a typo like "999999999999" can't overflow the Int column. */
export const MAX_RUNS_LIMIT = 100_000;

/**
 * Coerce arbitrary input (form string, JSON number, null) into `maxRuns`.
 * Returns null for "unlimited": empty/blank, non-numeric, or < 1.
 */
export function normalizeMaxRuns(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  const int = Math.floor(n);
  if (int < 1) return null;
  return Math.min(int, MAX_RUNS_LIMIT);
}

/**
 * True when a recurring template has used up its configured run budget and must not be
 * fired again by the worker. Unlimited templates (maxRuns null) are never exhausted.
 */
export function hasReachedRunLimit(task: { maxRuns?: number | null; runCount?: number | null }): boolean {
  const max = task.maxRuns ?? null;
  if (max === null) return false;
  return (task.runCount ?? 0) >= max;
}

/** Runs left before the cap is hit, or null when unlimited. */
export function runsRemaining(task: { maxRuns?: number | null; runCount?: number | null }): number | null {
  const max = task.maxRuns ?? null;
  if (max === null) return null;
  return Math.max(0, max - (task.runCount ?? 0));
}

/** Short human label for the UI, e.g. "3 / 5 runs" or "3 runs". */
export function formatRunUsage(task: { maxRuns?: number | null; runCount?: number | null }): string {
  const count = task.runCount ?? 0;
  const max = task.maxRuns ?? null;
  return max === null ? `${count} run${count === 1 ? "" : "s"}` : `${count} / ${max} runs`;
}
