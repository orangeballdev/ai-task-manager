/**
 * Optional per-task "thinking effort" override, set via Advanced Options at
 * task creation/edit time. Mirrors the Claude CLI's `--effort <level>` flag
 * and the Anthropic API's `output_config.effort` parameter — see
 * CliProvider/ApiProvider in src/lib/providers/. When unset (null), the
 * worker omits the flag/param entirely and the CLI/API's own default applies,
 * rather than us hard-coding a default value here.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type TaskEffort = (typeof EFFORT_LEVELS)[number];

export const EFFORT_LABELS: Record<TaskEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function isTaskEffort(v: unknown): v is TaskEffort {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/**
 * Normalizes to a valid effort level, or null when unset/invalid — null means
 * "use the provider's own default" rather than a specific level.
 */
export function normalizeEffort(v: unknown): TaskEffort | null {
  return isTaskEffort(v) ? v : null;
}
