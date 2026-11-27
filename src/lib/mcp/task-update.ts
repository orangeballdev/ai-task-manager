// Pure half of the MCP `update_task` tool: turns a tool call's arguments into the
// column changes for one task, without touching the database. The handler in
// ./tools.ts loads the task(s), calls planTaskEdit() for each, resolves the few
// things that need I/O (repo default branches, that a dependency/team exists) and
// writes the result.
//
// It covers the same fields the task edit form sends to PATCH /api/tasks/[id], so a
// client never has to fall back to the UI to change, say, the "After task
// completes" mode or a repo's base branch.
import { McpToolError, argBoolean, argEnum, argNumber, argString, argStringList } from "./protocol";
import { PRIORITY_LEVELS, normalizePriority } from "@/lib/priority";
import { normalizeEffort } from "@/lib/effort";
import { REPO_GIT_MODES, deriveAlias, gitFieldsForMode, type RepoGitMode } from "@/lib/repos";
import { AGENT_TOOLS, getAgentTool, normalizeToolAccess } from "@/lib/agent-tools";
import { MAX_RUNS_LIMIT, normalizeMaxRuns } from "@/lib/max-runs";
import { CronExpressionParser } from "cron-parser";
import { parseReviewMetadata } from "@/lib/review-only";

export const OUTPUT_TYPES = ["repository", "file", "design", "result"] as const;

/** The task columns planTaskEdit() reads. */
export interface EditableTask {
  id: string;
  status: string;
  labels: string | null;
  notes: string | null;
  outputType: string | null;
  pushToMain: boolean | null;
  createPR: boolean | null;
  targetBranch: string | null;
  toolAccess: string | null;
  isRecurringTemplate: boolean;
  cronExpression: string | null;
  repos: { alias: string; url: string; branch: string | null }[];
  /** Review-only ticket (src/lib/review-only.ts): only ticket fields and review metadata can change. */
  reviewOnly?: boolean;
}

/** What update_task can change on a review-only task — it never runs, so run settings don't apply. */
export const REVIEW_ONLY_EDITABLE_FIELDS = new Set([
  "title", "description", "context", "priority", "labels", "addLabels", "removeLabels", "notes", "appendNote", "reviewMetadata",
]);

/**
 * A repo row after the edit. `branch: undefined` means "the caller asked for the
 * repo's default" — the handler resolves it against the saved repo's
 * `defaultBranch` (null when it has none, i.e. Settings → Git at run time).
 */
export interface PlannedRepo {
  alias: string;
  url: string;
  branch: string | null | undefined;
}

export interface TaskEditPlan {
  /** Scalar Task columns to write. */
  data: Record<string, unknown>;
  /** The task's full repo list after the edit, when it changes. */
  repos?: PlannedRepo[];
  /** Ids the handler must check exist before writing ("" / null = clearing, nothing to check). */
  dependsOnTaskId?: string | null;
  teamId?: string | null;
  /** Provider connection id the handler must check exists and is enabled. */
  aiProviderId?: string | null;
}

// ---------------------------------------------------------------------------
// Provider choice
// ---------------------------------------------------------------------------

/** How the `provider` argument is spelled for "let the smart picker choose". */
export const SMART_PROVIDER = "smart";

export interface ProviderChoice {
  aiProviderId: string | null;
  useSmartProvider: boolean;
}

/**
 * The `provider` argument of create_task / update_task: a connection id (pin it),
 * "smart" (Smart Provider Picker) or "" / null (the default provider). Returns
 * undefined when the argument wasn't passed.
 */
export function parseProviderArg(args: Record<string, unknown>, key = "provider"): ProviderChoice | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return { aiProviderId: null, useSmartProvider: false };
  if (typeof v !== "string") throw new McpToolError(`'${key}' must be a provider id from list_providers, "${SMART_PROVIDER}", or "" for the default.`);
  const id = v.trim();
  if (id.toLowerCase() === SMART_PROVIDER) return { aiProviderId: null, useSmartProvider: true };
  return { aiProviderId: id, useSmartProvider: false };
}

// ---------------------------------------------------------------------------
// Recurring schedule
// ---------------------------------------------------------------------------

/** Validates a cron expression the way the worker will parse it; returns it trimmed. */
export function validateCron(expr: string, key = "cronExpression"): string {
  const trimmed = expr.trim();
  try {
    CronExpressionParser.parse(trimmed);
  } catch (err) {
    throw new McpToolError(
      `'${key}' isn't a valid cron expression (${err instanceof Error ? err.message : String(err)}). ` +
        "Use five fields — minute hour day-of-month month day-of-week — e.g. \"0 9 * * 1-5\" for 9am on weekdays.",
    );
  }
  return trimmed;
}

/**
 * When the worker will next fire a recurring template: the first cron match after
 * its last run (or creation), never earlier than `now` since an overdue template
 * fires on the next poll. Null when it won't fire again.
 */
export function nextCronRun(
  template: { cronExpression: string | null; isEnabled: boolean; maxRuns: number | null; runCount: number | null; lastScheduledAt: Date | null; createdAt: Date },
  now: Date,
): Date | null {
  if (!template.cronExpression || !template.isEnabled) return null;
  if (template.maxRuns !== null && (template.runCount ?? 0) >= template.maxRuns) return null;
  try {
    const next = CronExpressionParser.parse(template.cronExpression, {
      currentDate: template.lastScheduledAt ?? template.createdAt,
    }).next().toDate();
    return next < now ? now : next;
  } catch {
    return null;
  }
}

/** `maxRuns` argument: positive integer, or 0 / null for unlimited. */
export function parseMaxRunsArg(args: Record<string, unknown>, key = "maxRuns"): number | null | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (v === null || v === 0 || v === "") return null;
  const n = argNumber(args, key, { min: 1, max: MAX_RUNS_LIMIT, integer: true });
  return normalizeMaxRuns(n);
}

/** "After task completes" mode a task is currently set to (same precedence the worker uses). */
export function gitModeOfTask(task: Pick<EditableTask, "pushToMain" | "createPR" | "targetBranch">): RepoGitMode {
  if (task.pushToMain) return "main";
  if (task.createPR) return "pr";
  if (task.targetBranch) return "target";
  return "branch";
}

/**
 * Fields that may change while the task is running. The worker reads everything
 * else (instructions, repos, git mode, team, budgets, tool access, …) once when the
 * run starts, so changing it mid-run would silently do nothing until the next run.
 */
export const RUNNING_SAFE_FIELDS = new Set([
  "title", "priority", "labels", "addLabels", "removeLabels", "notes", "appendNote",
  // enabled:false is rejected separately (that's cancel_task); true is a no-op.
  "enabled", "scheduledFor",
]);

/** Argument keys that are not task fields (identify which task(s) to edit). */
const SELECTOR_KEYS = new Set(["id", "ids"]);

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseDate(value: string, key: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new McpToolError(`'${key}' must be an ISO-8601 date/time, e.g. 2026-01-31T09:00:00Z.`);
  return d;
}

/** A number that may also be cleared with null, "" or 0. */
function clearableNumber(args: Record<string, unknown>, key: string, opts: { integer?: boolean }): number | null {
  const v = args[key];
  if (v === null || v === "" || v === 0) return null;
  const n = argNumber(args, key, { min: 0, integer: opts.integer });
  return n ? n : null;
}

/** "" / null clears; anything else must be a non-empty string id. */
function clearableId(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  return argString(args, key, { required: true });
}

function parseRepoList(raw: unknown): PlannedRepo[] {
  if (!Array.isArray(raw)) throw new McpToolError("'repos' must be an array.");
  return raw.map((r) => {
    if (typeof r === "string" && r.trim()) return { alias: deriveAlias(r.trim()), url: r.trim(), branch: undefined };
    if (r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string" && (r as { url: string }).url.trim()) {
      const o = r as { url: string; alias?: unknown; branch?: unknown };
      const url = o.url.trim();
      const alias = typeof o.alias === "string" && o.alias.trim() ? o.alias.trim() : deriveAlias(url);
      const branch = typeof o.branch === "string" && o.branch.trim() ? o.branch.trim() : undefined;
      return { alias, url, branch };
    }
    throw new McpToolError("Each repo must be a URL string or an object with a 'url'.");
  });
}

function applyRepoBranches(repos: PlannedRepo[], raw: unknown): PlannedRepo[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new McpToolError("'repoBranches' must be an object mapping a repo alias (or URL) to a branch name.");
  }
  const next = repos.map((r) => ({ ...r }));
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const repo = next.find((r) => r.alias === key) ?? next.find((r) => r.url === key);
    if (!repo) {
      const known = repos.map((r) => r.alias).join(", ") || "(none)";
      throw new McpToolError(`'repoBranches': this task has no repo '${key}'. Its repos are: ${known}.`);
    }
    if (value !== null && typeof value !== "string") throw new McpToolError(`'repoBranches.${key}' must be a branch name, or "" for the repo default.`);
    repo.branch = typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return next;
}

/**
 * Plans one task's edit. Throws McpToolError for anything invalid — including an
 * edit the task's current state doesn't allow — so nothing is written for a bad call.
 */
export function planTaskEdit(task: EditableTask, args: Record<string, unknown>): TaskEditPlan {
  const has = (k: string) => args[k] !== undefined;
  const fields = Object.keys(args).filter((k) => !SELECTOR_KEYS.has(k) && has(k));

  if (task.status === "running") {
    if (args.enabled === false) throw new McpToolError("This task is running. Use cancel_task to stop it.");
    const blocked = fields.filter((k) => !RUNNING_SAFE_FIELDS.has(k));
    if (blocked.length) {
      throw new McpToolError(
        `This task is running, so ${blocked.join(", ")} can't be changed — the worker read them when the run started. ` +
          "Use send_task_message to steer it, or cancel_task first and edit it before re-running.",
      );
    }
  }

  if (task.reviewOnly) {
    const blocked = fields.filter((k) => !REVIEW_ONLY_EDITABLE_FIELDS.has(k));
    if (blocked.length) {
      throw new McpToolError(
        `This is a review-only task — it never runs, so ${blocked.join(", ")} can't be set. ` +
          "It takes title, description, context, priority, labels, notes and reviewMetadata.",
      );
    }
  }

  const data: Record<string, unknown> = {};
  const plan: TaskEditPlan = { data };

  // --- Review metadata (review-only tasks) ---------------------------------
  if (has("reviewMetadata")) {
    const meta = parseReviewMetadata(args.reviewMetadata);
    if (!meta.ok) throw new McpToolError(meta.message);
    if (!task.reviewOnly && Object.keys(meta.columns).length) {
      throw new McpToolError("'reviewMetadata' only applies to review-only tasks (create one with create_task reviewOnly: true).");
    }
    Object.assign(data, meta.columns);
  }

  // --- Text and scheduling -------------------------------------------------
  const title = argString(args, "title");
  if (title) data.title = title;
  if (has("description")) {
    const description = argString(args, "description");
    if (!description) throw new McpToolError("'description' can't be empty.");
    data.description = description;
  }
  if (has("context")) data.context = typeof args.context === "string" && args.context.trim() ? args.context.trim() : null;
  if (has("priority")) data.priority = normalizePriority(argEnum(args, "priority", PRIORITY_LEVELS));
  if (has("effort")) data.effort = normalizeEffort(args.effort);
  if (has("model")) data.model = argString(args, "model") ?? null;

  const replace = argStringList(args, "labels");
  const add = argStringList(args, "addLabels") ?? [];
  const remove = new Set(argStringList(args, "removeLabels") ?? []);
  if (replace || add.length || remove.size) {
    const base = replace ?? parseJson<string[]>(task.labels) ?? [];
    const next = [...new Set([...base, ...add])].filter((l) => !remove.has(l));
    data.labels = next.length ? JSON.stringify(next) : null;
  }

  if (has("notes")) data.notes = typeof args.notes === "string" && args.notes.length ? args.notes : null;
  const appendNote = argString(args, "appendNote");
  if (appendNote) {
    const current = has("notes") ? (data.notes as string | null) : task.notes;
    data.notes = [current, appendNote].filter(Boolean).join("\n\n");
  }

  const enabled = argBoolean(args, "enabled");
  if (enabled !== undefined) data.isEnabled = enabled;
  if (has("scheduledFor")) {
    const s = argString(args, "scheduledFor");
    data.scheduledFor = s ? parseDate(s, "scheduledFor") : null;
  }

  // --- Git: after-completion mode and target branch ------------------------
  const mode = argEnum(args, "afterCompletion", REPO_GIT_MODES) as RepoGitMode | undefined;
  if (has("targetBranch") || mode) {
    const targetArg = argString(args, "targetBranch");
    if (mode && mode !== "target" && targetArg) {
      throw new McpToolError(`'targetBranch' only applies when afterCompletion is 'target' (got '${mode}').`);
    }
    if (!mode && !targetArg) {
      throw new McpToolError("An empty 'targetBranch' needs an 'afterCompletion' mode to switch to instead (branch, pr or main).");
    }
    // A bare targetBranch means "push to this branch" — i.e. target mode.
    const nextMode: RepoGitMode = mode ?? "target";
    const target = targetArg ?? (nextMode === "target" ? task.targetBranch : null);
    if (nextMode === "target" && !target) {
      throw new McpToolError("'targetBranch' is required when afterCompletion is 'target'.");
    }
    Object.assign(data, gitFieldsForMode(nextMode, target));
  }

  // --- Repos ---------------------------------------------------------------
  if (has("repos") && has("repoBranches")) {
    throw new McpToolError("Pass either 'repos' (replace the whole list) or 'repoBranches' (change branches of existing repos), not both.");
  }
  if (has("repos")) plan.repos = parseRepoList(args.repos);
  if (has("repoBranches")) {
    plan.repos = applyRepoBranches(task.repos.map((r) => ({ ...r })), args.repoBranches);
  }

  if (has("outputType")) data.outputType = argEnum(args, "outputType", OUTPUT_TYPES);
  const finalOutput = (data.outputType as string | undefined) ?? task.outputType ?? "repository";
  const finalRepoCount = plan.repos ? plan.repos.length : task.repos.length;
  if ((has("outputType") || has("repos")) && finalOutput === "repository" && finalRepoCount === 0) {
    throw new McpToolError("A 'repository' task needs at least one repo. Pass repos, or set outputType to 'file', 'design' or 'result'.");
  }

  // --- Run settings --------------------------------------------------------
  if (has("dependsOnTaskId")) {
    const dep = clearableId(args, "dependsOnTaskId");
    if (dep === task.id) throw new McpToolError("A task can't depend on itself.");
    plan.dependsOnTaskId = dep;
    data.dependsOnTaskId = dep;
  }
  if (has("teamId")) {
    plan.teamId = clearableId(args, "teamId");
    data.teamId = plan.teamId;
  }
  const allowSubtasks = argBoolean(args, "allowSubtasks");
  if (allowSubtasks !== undefined) data.allowSubtasks = allowSubtasks;
  if (has("tokenBudget")) data.tokenBudget = clearableNumber(args, "tokenBudget", { integer: true });
  if (has("costBudget")) data.costBudget = clearableNumber(args, "costBudget", {});

  if (has("toolAccess")) {
    const raw = args.toolAccess;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new McpToolError("'toolAccess' must be an object mapping a tool id to true (grant), false (deny) or null (follow the default).");
    }
    const merged: Record<string, boolean> = normalizeToolAccess(task.toolAccess);
    for (const [toolId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!getAgentTool(toolId)) {
        throw new McpToolError(`'toolAccess': unknown tool '${toolId}'. Known tools: ${AGENT_TOOLS.map((t) => t.id).join(", ")}.`);
      }
      if (value === null) delete merged[toolId];
      else if (typeof value === "boolean") merged[toolId] = value;
      else throw new McpToolError(`'toolAccess.${toolId}' must be true, false or null.`);
    }
    data.toolAccess = Object.keys(merged).length ? JSON.stringify(merged) : null;
  }

  // --- Provider ------------------------------------------------------------
  const provider = parseProviderArg(args);
  if (provider) {
    data.aiProviderId = provider.aiProviderId;
    data.useSmartProvider = provider.useSmartProvider;
    plan.aiProviderId = provider.aiProviderId;
  }

  // --- Recurring schedule (templates only) ---------------------------------
  const scheduleKeys = ["cronExpression", "maxRuns", "resetRunCount"].filter(has);
  if (scheduleKeys.length && !task.isRecurringTemplate) {
    throw new McpToolError(
      `${scheduleKeys.join(", ")} only apply to recurring templates and this is a one-off task. ` +
        "To run it on a schedule, create a recurring task with create_task and cronExpression.",
    );
  }
  if (has("cronExpression")) {
    const cron = argString(args, "cronExpression");
    if (!cron) throw new McpToolError("'cronExpression' can't be cleared. Use enabled: false to pause a recurring task.");
    const next = validateCron(cron);
    if (next !== task.cronExpression) {
      data.cronExpression = next;
      // Count the new schedule from now. Otherwise the worker measures it from the
      // template's last run and an overdue match would fire on the very next poll.
      data.lastScheduledAt = new Date();
    }
  }
  const maxRuns = parseMaxRunsArg(args);
  if (maxRuns !== undefined) data.maxRuns = maxRuns;
  if (argBoolean(args, "resetRunCount")) data.runCount = 0;

  if (Object.keys(data).length === 0 && !plan.repos) {
    throw new McpToolError("Nothing to update — pass at least one field to change.");
  }
  return plan;
}
