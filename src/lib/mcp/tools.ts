// The MCP server's tools and prompts — the I/O half of src/lib/mcp/protocol.ts.
//
// Read tools let an MCP client (Claude Code, Claude Desktop, Cursor, …) answer
// questions about tasks: list/search them, inspect one in depth (including its logs,
// PR and test plan), read output files, and get board-wide stats. Write tools mirror
// the UI's buttons — create, edit, start, cancel, message, review — and go through the
// same code paths (src/lib/task-actions.ts) so they behave identically.
//
// Deliberately not exposed: deleting tasks, and editing settings/providers/teams.
// Those are irreversible or global, and are one click away in the UI.
import { recordTaskReview } from "@/lib/task-evaluation";
import { buildTeamProgressView, parseTeamProgress } from "@/lib/team-progress";
import { prisma } from "@/lib/db";
import type { Prisma, Task, TaskLog, TaskRepo } from "@/generated/prisma/client";

type TaskWithRepos = Task & { repos: TaskRepo[] };
import { PRIORITY_LEVELS } from "@/lib/priority";
import { EFFORT_LEVELS } from "@/lib/effort";
import { REPO_GIT_MODES, gitFieldsForMode, getSavedRepos, resolveRepoBranches, type RepoGitMode } from "@/lib/repos";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import {
  OUTPUT_TYPES,
  SMART_PROVIDER,
  gitModeOfTask,
  nextCronRun,
  parseMaxRunsArg,
  parseProviderArg,
  planTaskEdit,
  validateCron,
  type TaskEditPlan,
} from "./task-update";
import { getModelsForProviderType } from "@/lib/models";
import { modelFitsProvider } from "@/lib/slack-provider";
import { columnFor } from "@/lib/kanban-column";
import type { Task as AppTask } from "@/lib/types";
import { listTeams } from "@/lib/teams";
import { hasReviewMetadata, planReviewDecision, readReviewMetadata, reviewSearchClauses } from "@/lib/review-only";
import { listWorkspaceFiles, readWorkspaceFile } from "@/lib/api-v1-files";
import { DOCS_TOPIC_IDS, docsTopicIndex, renderDocsTopic } from "@/lib/docs-content";
import {
  checkProviderUsable,
  createTaskFromInput,
  killTask,
  decideTeamApproval,
  requestTaskChanges,
  sendTaskMessage,
  startTask,
  type ActionResult,
} from "@/lib/task-actions";
import {
  McpToolError,
  argBoolean,
  argEnum,
  argNumber,
  argString,
  argStringList,
  truncate,
  type McpPromptDefinition,
  type McpServerConfig,
  type McpToolDefinition,
} from "./protocol";

/** Per-request context handed to every tool handler. */
export interface McpToolContext {
  tokenId: string;
  tokenName: string;
  /** This deployment's public origin, e.g. https://tasks.example.com — for absolute links in docs. */
  origin: string;
}

type Tool = McpToolDefinition<McpToolContext>;

export const TASK_STATUSES = [
  "pending", "running", "paused", "throttled", "awaiting_approval", "completed", "no_changes", "failed", "killed", "timedout",
] as const;

const BOARD_COLUMNS = ["todo", "in_progress", "in_review", "done"] as const;

/** JSON schema of the review metadata object (create_task / update_task). */
const REVIEW_METADATA_SCHEMA = {
  type: "object",
  description:
    "Review metadata for a reviewOnly task — what to look at. Every field is optional. repo: a saved repo's URL " +
    "(see list_repositories) or any Git URL; branch; commits: one or more commit SHAs (7–40 hex chars, short or full, " +
    "stored as given); prUrl: an http(s) link to the PR. On update_task only the keys you pass change; null, \"\" or [] clears one.",
  properties: {
    repo: { type: ["string", "null"], description: "Git URL, e.g. git@github.com:owner/repo.git or https://github.com/owner/repo." },
    branch: { type: ["string", "null"] },
    commits: { type: ["array", "null"], items: { type: "string" }, description: "Commit SHAs, e.g. [\"65948886\"]." },
    prUrl: { type: ["string", "null"], description: "http(s) URL of the pull request." },
  },
  additionalProperties: false,
};

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new McpToolError(result.message);
  return result.value;
}

function unwrapCheck(error: { message: string } | null): void {
  if (error) throw new McpToolError(error.message);
}

/**
 * Rejects pinning a provider whose vendor can't run the task's model (e.g. a gpt-*
 * model on an Anthropic connection) — the worker would silently drop the model.
 */
async function assertModelFits(model: string | null | undefined, providerId: string, task?: { id: string; title: string }) {
  if (!model) return;
  const provider = await prisma.aIProvider.findUnique({ where: { id: providerId }, select: { name: true, type: true } });
  if (!provider || modelFitsProvider(model, provider.type)) return;
  const which = task ? `Task ${task.id} (${task.title}) uses` : "The";
  throw new McpToolError(
    `${which} model '${model}', which provider '${provider.name}' (${provider.type}) can't run. ` +
      "Pass a model it offers (see list_providers), or model \"\" for its default.",
  );
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseDate(value: string | undefined, key: string): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new McpToolError(`'${key}' must be an ISO-8601 date/time, e.g. 2026-01-31T09:00:00Z.`);
  return d;
}

function boardColumn(task: Task): string | null {
  return columnFor(task as unknown as AppTask);
}

async function requireTask(id: string) {
  const task = await prisma.task.findUnique({ where: { id }, include: { repos: true } });
  if (!task) throw new McpToolError(`No task found with id '${id}'. Use list_tasks to find task ids.`);
  return task;
}

/** Compact shape used in lists — enough to answer most questions without get_task. */
export function summarizeTask(task: Task & { repos?: TaskRepo[] }) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    boardColumn: boardColumn(task),
    reviewStatus: task.reviewStatus,
    reviewOnly: task.reviewOnly,
    ...((task.reviewOnly || hasReviewMetadata(readReviewMetadata(task))) && { reviewMetadata: readReviewMetadata(task) }),
    enabled: task.isEnabled,
    priority: task.priority,
    labels: parseJson<string[]>(task.labels) ?? [],
    repos: (task.repos ?? []).map((r) => ({ alias: r.alias, url: r.url, branch: r.branch })),
    outputType: task.outputType,
    afterCompletion: gitModeOfTask(task),
    targetBranch: task.targetBranch,
    description: truncate(task.description, 300),
    branchName: task.branchName,
    prUrl: task.prUrl,
    estimatedCost: task.estimatedCost,
    retryCount: task.retryCount,
    parentTaskId: task.parentTaskId,
    ...(task.isRecurringTemplate
      ? { recurring: { cronExpression: task.cronExpression, maxRuns: task.maxRuns, runCount: task.runCount } }
      : { recurringTemplateId: task.recurringTemplateId }),
    scheduledFor: task.scheduledFor?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const listTasks: Tool = {
  name: "list_tasks",
  title: "List / search tasks",
  access: "read",
  description:
    "List and search tasks, newest first by default. Combine filters freely: status, board column, free-text query " +
    "(matches title, description and context, plus commit SHAs and PR URLs — review metadata and agent PRs), label, " +
    "repository, review status, review-only tickets, date range. Returns compact summaries " +
    "plus the total match count — use get_task for full details of one task.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Case-insensitive text to find in title, description or context, or a commit SHA / PR URL (review metadata, an agent's commit or PR).",
      },
      status: {
        type: "array",
        items: { type: "string", enum: [...TASK_STATUSES] },
        description: "Only tasks with one of these statuses.",
      },
      boardColumn: {
        type: "string",
        enum: [...BOARD_COLUMNS],
        description: "Only tasks shown in this Kanban column (todo, in_progress, in_review, done).",
      },
      label: { type: "string", description: "Only tasks carrying this label." },
      repo: { type: "string", description: "Only tasks touching a repo whose URL or alias contains this text." },
      reviewStatus: { type: "string", enum: ["in_review", "done"], description: "Filter by review status." },
      parentTaskId: { type: "string", description: "Only subtasks of this task." },
      reviewOnly: { type: "boolean", description: "true = only review-only tickets (never run, created In Review); false = only agent tasks." },
      recurringTemplates: {
        type: "boolean",
        description: "true = list recurring task templates (the schedules themselves) instead of tasks. Default false.",
      },
      recurringTemplateId: { type: "string", description: "Only the runs spawned by this recurring template." },
      enabled: { type: "boolean", description: "false = only backlog (disabled) tasks; true = only enabled tasks." },
      createdAfter: { type: "string", description: "ISO-8601 date/time." },
      createdBefore: { type: "string", description: "ISO-8601 date/time." },
      sort: {
        type: "string",
        enum: ["newest", "oldest", "recently_updated", "queue"],
        description: "Default newest. 'queue' = the worker's pick-up order (priority, then position).",
      },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
      offset: { type: "integer", minimum: 0, description: "For paging. Default 0." },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const query = argString(args, "query");
    const statuses = argStringList(args, "status");
    const column = argEnum(args, "boardColumn", BOARD_COLUMNS);
    const label = argString(args, "label");
    const repo = argString(args, "repo");
    const reviewStatus = argEnum(args, "reviewStatus", ["in_review", "done"] as const);
    const parentTaskId = argString(args, "parentTaskId");
    const reviewOnly = argBoolean(args, "reviewOnly");
    const templatesOnly = argBoolean(args, "recurringTemplates") ?? false;
    const recurringTemplateId = argString(args, "recurringTemplateId");
    const enabled = argBoolean(args, "enabled");
    const createdAfter = parseDate(argString(args, "createdAfter"), "createdAfter");
    const createdBefore = parseDate(argString(args, "createdBefore"), "createdBefore");
    const sort = argEnum(args, "sort", ["newest", "oldest", "recently_updated", "queue"] as const) ?? "newest";
    const limit = argNumber(args, "limit", { min: 1, max: 100, integer: true }) ?? 25;
    const offset = argNumber(args, "offset", { min: 0, integer: true }) ?? 0;

    if (statuses) {
      const bad = statuses.filter((s) => !(TASK_STATUSES as readonly string[]).includes(s));
      if (bad.length) throw new McpToolError(`Unknown status: ${bad.join(", ")}. Valid: ${TASK_STATUSES.join(", ")}.`);
    }

    const and: Prisma.TaskWhereInput[] = [{ isRecurringTemplate: templatesOnly }];
    if (recurringTemplateId) and.push({ recurringTemplateId });
    // SQLite LIKE (what Prisma's `contains` compiles to) is case-insensitive for ASCII.
    if (query) {
      and.push({
        OR: [
          { title: { contains: query } },
          { description: { contains: query } },
          { context: { contains: query } },
          ...(reviewSearchClauses(query) as Prisma.TaskWhereInput[]),
        ],
      });
    }
    if (reviewOnly !== undefined) and.push({ reviewOnly });
    if (statuses?.length) and.push({ status: { in: statuses } });
    if (label) and.push({ labels: { contains: JSON.stringify(label) } });
    if (repo) and.push({ repos: { some: { OR: [{ url: { contains: repo } }, { alias: { contains: repo } }] } } });
    if (reviewStatus) and.push({ reviewStatus });
    if (parentTaskId) and.push({ parentTaskId });
    if (enabled !== undefined) and.push({ isEnabled: enabled });
    if (createdAfter) and.push({ createdAt: { gte: createdAfter } });
    if (createdBefore) and.push({ createdAt: { lte: createdBefore } });
    const where: Prisma.TaskWhereInput = { AND: and };

    const orderBy: Prisma.TaskOrderByWithRelationInput[] =
      sort === "oldest" ? [{ createdAt: "asc" }]
        : sort === "recently_updated" ? [{ updatedAt: "desc" }]
          : sort === "queue" ? [{ position: "asc" }]
            : [{ createdAt: "desc" }];

    if (column) {
      // The board column is derived (status + reviewStatus + PR state), so it can't be
      // expressed as a WHERE clause — filter in memory over a bounded window.
      const rows: TaskWithRepos[] = await prisma.task.findMany({ where, include: { repos: true }, orderBy, take: 2000 });
      const matching = rows.filter((t) => boardColumn(t) === column);
      return {
        total: matching.length,
        offset,
        tasks: matching.slice(offset, offset + limit).map(summarizeTask),
      };
    }

    const [total, rows] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({ where, include: { repos: true }, orderBy, skip: offset, take: limit }),
    ]);
    return { total, offset, tasks: rows.map(summarizeTask) };
  },
};

const getTask: Tool = {
  name: "get_task",
  title: "Get task details",
  access: "read",
  description:
    "Everything about one task: full description and context, status and board column, repos and branches, PR(s) " +
    "and CI/merge state, PR summary and test plan written by the agent, notes, cost and tokens, schedule, " +
    "dependencies, parent/subtasks, team, provider — plus its most recent log lines. Use this to review a task or " +
    "answer detailed questions about what it did.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id." },
      logLines: {
        type: "integer",
        minimum: 0,
        maximum: 200,
        description: "How many of the most recent log lines to include (default 30, 0 for none). Use get_task_logs for more.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async handler(args) {
    const id = argString(args, "id", { required: true });
    const logLines = argNumber(args, "logLines", { min: 0, max: 200, integer: true }) ?? 30;

    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        repos: true,
        dependsOn: { select: { id: true, title: true, status: true } },
        dependents: { select: { id: true, title: true, status: true } },
        parentTask: { select: { id: true, title: true, status: true } },
        subtasks: { select: { id: true, title: true, status: true }, orderBy: { createdAt: "asc" } },
        team: { select: { id: true, name: true } },
        aiProvider: { select: { id: true, name: true, type: true } },
        recurringTemplate: { select: { id: true, title: true } },
        _count: { select: { logs: true } },
      },
    });
    if (!task) throw new McpToolError(`No task found with id '${id}'. Use list_tasks to find task ids.`);

    const logs: TaskLog[] = logLines > 0
      ? (await prisma.taskLog.findMany({ where: { taskId: id }, orderBy: { createdAt: "desc" }, take: logLines })).reverse()
      : [];

    return {
      ...summarizeTask(task),
      description: task.description,
      context: task.context,
      notes: task.notes,
      model: task.model,
      effort: task.effort,
      provider: task.aiProvider ? { id: task.aiProvider.id, name: task.aiProvider.name, type: task.aiProvider.type } : null,
      useSmartProvider: task.useSmartProvider,
      team: task.team,
      ...(task.team && { teamProgress: teamProgressSummary(task.teamProgress, task.status) }),
      afterCompletion: gitModeOfTask(task),
      targetBranch: task.targetBranch,
      commitSha: task.commitSha,
      prNumber: task.prNumber,
      prUrls: parseJson(task.prUrls),
      prError: task.prError,
      ciStatus: task.ciStatus,
      mergeableState: task.mergeableState,
      hasConflict: task.hasConflict,
      conflictMessage: task.conflictMessage,
      prSummary: task.prSummary,
      testPlan: task.testPlan,
      inputTokens: task.inputTokens,
      outputTokens: task.outputTokens,
      tokenBudget: task.tokenBudget,
      costBudget: task.costBudget,
      reviewIterationCount: task.reviewIterationCount,
      nextRetryAt: task.nextRetryAt?.toISOString() ?? null,
      cronExpression: task.cronExpression,
      ...(task.isRecurringTemplate && {
        isRecurringTemplate: true,
        maxRuns: task.maxRuns,
        runCount: task.runCount,
        lastRunAt: task.lastScheduledAt?.toISOString() ?? null,
        nextRunAt: nextCronRun(task, new Date())?.toISOString() ?? null,
      }),
      recurringTemplate: task.recurringTemplate,
      allowSubtasks: task.allowSubtasks,
      dependsOn: task.dependsOn,
      dependents: task.dependents,
      parentTask: task.parentTask,
      subtasks: task.subtasks,
      totalLogLines: task._count.logs,
      recentLogs: logs.map((l) => ({ at: l.createdAt.toISOString(), level: l.level, ...(l.member && { member: l.member }), content: truncate(l.content, 2000) })),
    };
  },
};

const getTaskLogs: Tool = {
  name: "get_task_logs",
  title: "Read task logs",
  access: "read",
  description:
    "Read a task's run log — agent output, tool calls, system events, errors, and user messages. Defaults to the " +
    "latest 100 lines. Filter by level or text to find why a task failed or what it changed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id." },
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "Default 100." },
      from: { type: "string", enum: ["end", "start"], description: "Read the latest lines (end, default) or the first lines (start)." },
      levels: {
        type: "array",
        items: { type: "string" },
        description: "Only these levels, e.g. [\"error\"] or [\"system\", \"error\"]. Common levels: info, system, error, user, tool.",
      },
      query: { type: "string", description: "Only lines containing this text." },
      maxCharsPerLine: { type: "integer", minimum: 100, maximum: 20000, description: "Truncate long lines (default 2000)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async handler(args) {
    const id = argString(args, "id", { required: true });
    const limit = argNumber(args, "limit", { min: 1, max: 1000, integer: true }) ?? 100;
    const from = argEnum(args, "from", ["end", "start"] as const) ?? "end";
    const levels = argStringList(args, "levels");
    const query = argString(args, "query");
    const maxChars = argNumber(args, "maxCharsPerLine", { min: 100, max: 20000, integer: true }) ?? 2000;
    await requireTask(id);

    const where: Prisma.TaskLogWhereInput = {
      taskId: id,
      ...(levels?.length && { level: { in: levels } }),
      ...(query && { content: { contains: query } }),
    };
    const [total, rows]: [number, TaskLog[]] = await Promise.all([
      prisma.taskLog.count({ where }),
      prisma.taskLog.findMany({ where, orderBy: { createdAt: from === "end" ? "desc" : "asc" }, take: limit }),
    ]);
    const ordered = from === "end" ? rows.reverse() : rows;
    return {
      taskId: id,
      totalMatching: total,
      returned: ordered.length,
      logs: ordered.map((l) => ({ at: l.createdAt.toISOString(), level: l.level, ...(l.member && { member: l.member }), content: truncate(l.content, maxChars) })),
    };
  },
};

// The team tracker in the shape the task page shows it: each member's stage status.
function teamProgressSummary(raw: string | null, status: string) {
  const view = buildTeamProgressView(parseTeamProgress(raw), [], status);
  if (!view.hasRun) return null;
  return {
    completed: view.completed,
    total: view.total,
    current: view.currentIndex !== null ? view.stages[view.currentIndex].name : null,
    // A stage waiting on manual approval (see approve_team_stage), with what it produced.
    ...(view.awaitingIndex !== null && {
      awaitingApproval: { member: view.stages[view.awaitingIndex].name, output: view.stages[view.awaitingIndex].output },
    }),
    stages: view.stages.map((s) => ({
      member: s.name, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt,
      ...(s.requiresApproval && { requiresApproval: true }),
      ...(s.note && { note: s.note }),
    })),
  };
}

const getTaskStats: Tool = {
  name: "get_task_stats",
  title: "Task statistics",
  access: "read",
  description:
    "Board-wide numbers for questions like \"how many tasks failed this week?\" or \"what did we spend on tasks " +
    "for repo X?\": counts by status and board column, tokens and cost totals, and the most recent failures. " +
    "Optionally limited to a date range (by creation time) and/or a repository.",
  inputSchema: {
    type: "object",
    properties: {
      since: { type: "string", description: "ISO-8601; only tasks created at/after this." },
      until: { type: "string", description: "ISO-8601; only tasks created at/before this." },
      repo: { type: "string", description: "Only tasks touching a repo whose URL or alias contains this text." },
      label: { type: "string", description: "Only tasks carrying this label." },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const since = parseDate(argString(args, "since"), "since");
    const until = parseDate(argString(args, "until"), "until");
    const repo = argString(args, "repo");
    const label = argString(args, "label");

    const and: Prisma.TaskWhereInput[] = [{ isRecurringTemplate: false }];
    if (since) and.push({ createdAt: { gte: since } });
    if (until) and.push({ createdAt: { lte: until } });
    if (repo) and.push({ repos: { some: { OR: [{ url: { contains: repo } }, { alias: { contains: repo } }] } } });
    if (label) and.push({ labels: { contains: JSON.stringify(label) } });

    const tasks: Task[] = await prisma.task.findMany({
      where: { AND: and },
      select: {
        id: true, title: true, status: true, reviewStatus: true, prUrl: true, prUrls: true,
        inputTokens: true, outputTokens: true, estimatedCost: true, isEnabled: true,
        createdAt: true, updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });

    const byStatus: Record<string, number> = {};
    const byColumn: Record<string, number> = {};
    let inputTokens = 0, outputTokens = 0, cost = 0, backlog = 0;
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      const col = boardColumn(t) ?? "none";
      byColumn[col] = (byColumn[col] ?? 0) + 1;
      inputTokens += t.inputTokens ?? 0;
      outputTokens += t.outputTokens ?? 0;
      cost += t.estimatedCost ?? 0;
      if (!t.isEnabled) backlog++;
    }
    const recentFailures = tasks
      .filter((t) => t.status === "failed" || t.status === "timedout")
      .slice(0, 10)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt.toISOString() }));

    return {
      range: { since: since?.toISOString() ?? null, until: until?.toISOString() ?? null },
      totalTasks: tasks.length,
      backlog,
      byStatus,
      byBoardColumn: byColumn,
      tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
      estimatedCostUsd: Math.round(cost * 10000) / 10000,
      recentFailures,
    };
  },
};

const listTaskFiles: Tool = {
  name: "list_task_files",
  title: "List a task's output files",
  access: "read",
  description:
    "List files in a task's workspace. File-output tasks write their results under 'output' (the default path); " +
    "repo tasks have one directory per repo alias.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id." },
      path: { type: "string", description: "Directory relative to the workspace root. Default 'output'." },
      recursive: { type: "boolean", description: "Walk subdirectories too (default false)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async handler(args) {
    const id = argString(args, "id", { required: true });
    const relPath = argString(args, "path") ?? "output";
    const recursive = argBoolean(args, "recursive") ?? false;
    await requireTask(id);
    const entries = await listWorkspaceFiles(id, relPath, recursive);
    if (entries === null) {
      throw new McpToolError(`No directory '${relPath}' in this task's workspace (it may not have run yet, or its workspace was cleaned up).`);
    }
    return { taskId: id, path: relPath, entries: entries.slice(0, 1000), truncated: entries.length > 1000 };
  },
};

const readTaskFile: Tool = {
  name: "read_task_file",
  title: "Read a task's output file",
  access: "read",
  description: "Read a text file from a task's workspace (path relative to the workspace root, as returned by list_task_files).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id." },
      path: { type: "string", description: "File path relative to the workspace root, e.g. 'output/report.md'." },
      maxChars: { type: "integer", minimum: 100, maximum: 500000, description: "Truncate after this many characters (default 100000)." },
    },
    required: ["id", "path"],
    additionalProperties: false,
  },
  async handler(args) {
    const id = argString(args, "id", { required: true });
    const relPath = argString(args, "path", { required: true });
    const maxChars = argNumber(args, "maxChars", { min: 100, max: 500000, integer: true }) ?? 100000;
    await requireTask(id);
    const result = await readWorkspaceFile(id, relPath);
    if (!result.ok) {
      const why = {
        not_found: "not found",
        is_directory: "is a directory — use list_task_files",
        too_large: "is too large to read",
        binary: "looks like a binary file",
      }[result.reason];
      throw new McpToolError(`'${relPath}' ${why}.`);
    }
    return { taskId: id, path: relPath, size: result.size, modifiedAt: result.modifiedAt, content: truncate(result.content, maxChars) };
  },
};

const listRepositories: Tool = {
  name: "list_repositories",
  title: "List saved repositories",
  access: "read",
  description:
    "Repositories saved on the Repositories page, with their per-repo task defaults (branch, after-completion mode, " +
    "priority, labels, …). Use the URL from here when creating a task.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler() {
    const repos = await getSavedRepos();
    return { repositories: repos };
  },
};

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  isEnabled: boolean;
  excludeFromSmartPicker: boolean;
  maxUsagePercent: number;
  model: string | null;
  throttledUntil: Date | null;
}

const listProviders: Tool = {
  name: "list_providers",
  title: "List AI providers",
  access: "read",
  description:
    "The AI provider connections tasks can run on (Claude subscriptions, API keys, Codex, …), for the 'provider' " +
    "argument of create_task / update_task. Shows which are enabled, the default, whether one is rate-limited right " +
    "now, and the models each offers. Disabled connections are listed but can't be chosen.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler() {
    // Select explicitly: the table also holds API keys, OAuth credentials and certificates.
    const providers = await prisma.aIProvider.findMany({
      select: {
        id: true, name: true, type: true, isDefault: true, isEnabled: true, excludeFromSmartPicker: true,
        maxUsagePercent: true, model: true, throttledUntil: true,
      },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    const now = new Date();
    return {
      providers: providers.map((p: ProviderRow) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        enabled: p.isEnabled,
        isDefault: p.isDefault,
        inSmartPicker: p.isEnabled && !p.excludeFromSmartPicker,
        usageCapPercent: p.maxUsagePercent < 100 ? p.maxUsagePercent : null,
        rateLimitedUntil: p.throttledUntil && p.throttledUntil > now ? p.throttledUntil.toISOString() : null,
        defaultModel: p.model,
        models: getModelsForProviderType(p.type).map((m) => m.id),
      })),
      note: `Pass a provider's id as 'provider' to pin it, or "${SMART_PROVIDER}" to let the Smart Provider Picker choose per run.`,
    };
  },
};

const listTeamsTool: Tool = {
  name: "list_teams",
  title: "List agent teams",
  access: "read",
  description: "Agent teams (ordered pipelines like Planner → Coder → Tester) that a task can be assigned to via teamId.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler() {
    const teams = await listTeams();
    return {
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        isDefault: t.isDefault,
        members: t.members.map((m) => ({
          name: m.name, position: m.position, instructions: truncate(m.instructions, 500),
          ...(m.requiresApproval && { requiresApproval: true }),
        })),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

const createTask: Tool = {
  name: "create_task",
  title: "Create a task",
  access: "write",
  annotations: { destructiveHint: false, idempotentHint: false },
  description:
    "Queue a new task for an AI agent to run against one or more Git repositories (or produce files). The worker " +
    "picks it up within seconds unless autoStart is false or it's scheduled. Repos saved on the Repositories page " +
    "supply defaults (branch, after-completion mode, priority, …) for anything you leave out — call " +
    "list_repositories to see them. Write the description as instructions to the agent. " +
    "reviewOnly: true instead creates a review-only ticket — a reminder to review work done elsewhere (a hand-pushed " +
    "commit, another session): it goes straight to In Review, never runs an agent and spends no tokens. Its description " +
    "says what to review and why (e.g. the commit message); attach the repo/branch/commits/PR in reviewMetadata. Run " +
    "options (repos, schedule, team, dependency, autoStart, budgets…) don't apply to it.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "What the agent should do — or, for reviewOnly, what to review and why. Required." },
      title: { type: "string", description: "Short title (defaults to the first 80 chars of the description)." },
      context: { type: "string", description: "Extra background/instructions for the agent." },
      repos: {
        type: "array",
        description: "Repositories to work in. Each item is a URL string or { url, alias?, branch? }. Required unless outputType is 'file', 'design' or 'result'.",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                url: { type: "string" },
                alias: { type: "string" },
                branch: { type: "string", description: "Base branch to clone (default: repo default / Settings → Git)." },
              },
              required: ["url"],
            },
          ],
        },
      },
      outputType: { type: "string", enum: [...OUTPUT_TYPES], description: "Default 'repository'." },
      afterCompletion: {
        type: "string",
        enum: [...REPO_GIT_MODES],
        description: "What happens to the work: 'branch' (push a new branch), 'pr' (open a pull request), 'main' (push to the default branch), 'target' (push to targetBranch). Omit to use the repo's default.",
      },
      targetBranch: { type: "string", description: "Branch to push to when afterCompletion is 'target'." },
      priority: { type: "string", enum: [...PRIORITY_LEVELS] },
      effort: { type: "string", enum: [...EFFORT_LEVELS], description: "Thinking effort for the agent." },
      model: { type: "string", description: "Model id override, e.g. claude-opus-5-5." },
      labels: { type: "array", items: { type: "string" } },
      autoStart: { type: "boolean", description: "false = create it in the backlog without running (start later with start_task). Default true." },
      scheduledFor: { type: "string", description: "ISO-8601 time to run it at instead of now." },
      dependsOnTaskId: { type: "string", description: "Don't run until this task has finished." },
      teamId: { type: "string", description: "Run through an agent team (see list_teams) instead of a single agent. Omit to use the repo's default team (defaultTeamId in list_repositories), if it has one." },
      allowSubtasks: { type: "boolean", description: "Let the agent queue follow-up subtasks of its own." },
      tokenBudget: { type: "integer", minimum: 1 },
      costBudget: { type: "number", description: "Max spend in USD." },
      provider: {
        type: "string",
        description: `AI provider connection id from list_providers, "${SMART_PROVIDER}" for the Smart Provider Picker, or "" for the default. Omit to use the repo's default.`,
      },
      cronExpression: {
        type: "string",
        description: "Make it a recurring task: a cron schedule (minute hour day-of-month month day-of-week, server time zone), e.g. \"0 9 * * 1-5\". Each time it fires the worker spawns a new run. autoStart false creates the schedule paused.",
      },
      maxRuns: { type: "integer", minimum: 1, description: "With cronExpression: stop after this many runs. Default unlimited." },
      reviewOnly: {
        type: "boolean",
        description: "true = a review-only ticket: created straight into In Review, never run by an agent. Approve it with review_task when reviewed.",
      },
      reviewMetadata: REVIEW_METADATA_SCHEMA,
      notes: { type: "string", description: "Private notes on the task (not shown to an agent)." },
    },
    required: ["description"],
    additionalProperties: false,
  },
  async handler(args) {
    if (argBoolean(args, "reviewOnly")) {
      const extra = Object.keys(args).filter((k) => args[k] !== undefined && !["description", "title", "context", "priority", "labels", "notes", "reviewOnly", "reviewMetadata"].includes(k));
      if (extra.length) {
        throw new McpToolError(
          `${extra.join(", ")} can't be used with reviewOnly — a review-only task never runs. ` +
            "It takes title, description, context, priority, labels, notes and reviewMetadata (put the repository in reviewMetadata.repo).",
        );
      }
      const task = unwrap(await createTaskFromInput({
        description: argString(args, "description", { required: true }),
        title: argString(args, "title"),
        context: argString(args, "context"),
        priority: argEnum(args, "priority", PRIORITY_LEVELS),
        labels: argStringList(args, "labels"),
        notes: argString(args, "notes"),
        reviewOnly: true,
        reviewMetadata: args.reviewMetadata,
      }));
      return {
        created: true,
        message: "Review-only task created in In Review. It won't run; approve it with review_task once reviewed.",
        task: summarizeTask(task),
      };
    }
    const rawRepos = args.repos;
    if (rawRepos !== undefined && !Array.isArray(rawRepos)) throw new McpToolError("'repos' must be an array.");
    const repos = ((rawRepos as unknown[] | undefined) ?? []).map((r) => {
      if (typeof r === "string") return { url: r.trim() };
      if (r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string") {
        const o = r as { url: string; alias?: unknown; branch?: unknown };
        return {
          url: o.url.trim(),
          alias: typeof o.alias === "string" ? o.alias : undefined,
          branch: typeof o.branch === "string" ? o.branch : undefined,
        };
      }
      throw new McpToolError("Each repo must be a URL string or an object with a 'url'.");
    });

    const mode = argEnum(args, "afterCompletion", REPO_GIT_MODES) as RepoGitMode | undefined;
    const targetBranch = argString(args, "targetBranch");
    if (mode === "target" && !targetBranch) throw new McpToolError("'targetBranch' is required when afterCompletion is 'target'.");
    const git = mode ? gitFieldsForMode(mode, targetBranch) : undefined;

    const provider = parseProviderArg(args);
    if (provider?.aiProviderId) await assertModelFits(argString(args, "model"), provider.aiProviderId);
    const cron = argString(args, "cronExpression");
    const cronExpression = cron ? validateCron(cron) : undefined;
    const maxRuns = parseMaxRunsArg(args);
    if (maxRuns && !cronExpression) throw new McpToolError("'maxRuns' only applies with a 'cronExpression'.");

    const task = unwrap(await createTaskFromInput({
      description: argString(args, "description", { required: true }),
      title: argString(args, "title"),
      context: argString(args, "context"),
      repos,
      outputType: argEnum(args, "outputType", OUTPUT_TYPES),
      priority: argEnum(args, "priority", PRIORITY_LEVELS),
      effort: argEnum(args, "effort", EFFORT_LEVELS),
      model: argString(args, "model"),
      labels: argStringList(args, "labels"),
      ...(git && { pushToMain: git.pushToMain, createPR: git.createPR, targetBranch: git.targetBranch ?? undefined }),
      autoStart: argBoolean(args, "autoStart"),
      scheduledFor: parseDate(argString(args, "scheduledFor"), "scheduledFor"),
      dependsOnTaskId: argString(args, "dependsOnTaskId"),
      teamId: argString(args, "teamId"),
      allowSubtasks: argBoolean(args, "allowSubtasks"),
      tokenBudget: argNumber(args, "tokenBudget", { min: 1, integer: true }),
      costBudget: argNumber(args, "costBudget", { min: 0 }),
      ...(provider && { aiProviderId: provider.aiProviderId, useSmartProvider: provider.useSmartProvider }),
      cronExpression,
      maxRuns,
      notes: argString(args, "notes"),
      reviewMetadata: args.reviewMetadata,
    }));

    if (task.isRecurringTemplate) {
      const next = nextCronRun(task, new Date());
      return {
        created: true,
        message: next
          ? `Recurring task created; first run ${next.toISOString()}. Find its runs with list_tasks recurringTemplateId.`
          : "Recurring task created paused; enable it with update_task enabled: true.",
        task: summarizeTask(task),
      };
    }
    return {
      created: true,
      message: task.isEnabled
        ? (task.scheduledFor ? `Task scheduled for ${task.scheduledFor.toISOString()}.` : "Task queued — the worker will pick it up shortly.")
        : "Task created in the backlog; call start_task to run it.",
      task: summarizeTask(task),
    };
  },
};

const updateTask: Tool = {
  name: "update_task",
  title: "Edit task(s)",
  access: "write",
  annotations: { destructiveHint: false, idempotentHint: true },
  description:
    "Edit a task — or several at once with 'ids' (e.g. every subtask from list_tasks parentTaskId) — the same fields " +
    "the UI's edit form can change. Only the fields you pass change. A bulk edit is all-or-nothing: if any task " +
    "rejects the edit, none are changed. While a task is running only title, priority, labels and notes can change " +
    "(the rest was read when the run started) — use send_task_message to steer it. Editing a finished task does not " +
    "re-run it; use start_task afterwards (or review_task with request_changes to iterate on its branch). On a " +
    "review-only task only title, description, context, priority, labels, notes and reviewMetadata (its repo, branch, " +
    "commits and PR link) can change.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id. Pass this or 'ids'." },
      ids: { type: "array", items: { type: "string" }, maxItems: 100, description: "Apply the same edit to each of these tasks." },
      title: { type: "string" },
      description: { type: "string" },
      context: { type: "string", description: "Replaces the context. Pass an empty string to clear it." },
      priority: { type: "string", enum: [...PRIORITY_LEVELS] },
      effort: { type: "string", enum: [...EFFORT_LEVELS, ""], description: "Empty string = provider default." },
      model: { type: "string", description: "Empty string = provider default." },
      labels: { type: "array", items: { type: "string" }, description: "Replaces all labels." },
      addLabels: { type: "array", items: { type: "string" } },
      removeLabels: { type: "array", items: { type: "string" } },
      notes: { type: "string", description: "Replaces the task's private notes (not shown to the agent)." },
      appendNote: { type: "string", description: "Appends a line to the notes instead of replacing them." },
      enabled: { type: "boolean", description: "false moves the task to the backlog (it won't be picked up); true re-enables it." },
      scheduledFor: { type: "string", description: "ISO-8601 time to run at; empty string clears the schedule." },
      afterCompletion: {
        type: "string",
        enum: [...REPO_GIT_MODES],
        description: "What happens to the work: 'branch' (push a new branch), 'pr' (open a pull request), 'main' (push to the default branch), 'target' (push to targetBranch).",
      },
      targetBranch: {
        type: "string",
        description: "Existing branch to push the work to. Passing it on its own switches afterCompletion to 'target'.",
      },
      repos: {
        type: "array",
        description: "Replaces the task's whole repo list. Each item is a URL string or { url, alias?, branch? }; a repo without a branch uses its saved default.",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: { url: { type: "string" }, alias: { type: "string" }, branch: { type: "string" } },
              required: ["url"],
            },
          ],
        },
      },
      repoBranches: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Change the base (clone) branch of repos already on the task, keyed by repo alias or URL, e.g. { \"api\": \"develop\" }. \"\" = the repo's default branch.",
      },
      outputType: { type: "string", enum: [...OUTPUT_TYPES] },
      dependsOnTaskId: { type: "string", description: "Don't run until this task has finished. Empty string removes the dependency." },
      teamId: { type: "string", description: "Run through an agent team (see list_teams). Empty string = single agent." },
      allowSubtasks: { type: "boolean", description: "Let the agent queue follow-up subtasks of its own." },
      tokenBudget: { type: ["integer", "null"], minimum: 0, description: "Max tokens; 0 or null removes the budget." },
      costBudget: { type: ["number", "null"], minimum: 0, description: "Max spend in USD; 0 or null removes the budget." },
      provider: {
        type: "string",
        description: `AI provider connection id from list_providers, "${SMART_PROVIDER}" for the Smart Provider Picker, or "" for the default provider.`,
      },
      cronExpression: { type: "string", description: "Recurring templates only: new cron schedule, counted from now." },
      maxRuns: { type: ["integer", "null"], minimum: 0, description: "Recurring templates only: cap on runs; 0 or null = unlimited." },
      resetRunCount: { type: "boolean", description: "Recurring templates only: true restarts the run count at 0 (e.g. after it hit maxRuns)." },
      reviewMetadata: REVIEW_METADATA_SCHEMA,
      toolAccess: {
        type: "object",
        additionalProperties: { type: ["boolean", "null"] },
        description: "Per-task external tool overrides, merged onto the current ones: tool id → true (grant), false (deny), null (follow the Settings default). Tools: " +
          AGENT_TOOLS.map((t) => `${t.id} (${t.name})`).join(", ") + ".",
      },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const single = argString(args, "id");
    const many = argStringList(args, "ids");
    if (single && many) throw new McpToolError("Pass either 'id' or 'ids', not both.");
    const ids = [...new Set(many ?? (single ? [single] : []))];
    if (ids.length === 0) throw new McpToolError("'id' (or 'ids') is required.");
    if (ids.length > 100) throw new McpToolError("At most 100 tasks can be edited in one call.");

    const tasks: TaskWithRepos[] = await prisma.task.findMany({ where: { id: { in: ids } }, include: { repos: true } });
    const missing = ids.filter((id) => !tasks.some((t) => t.id === id));
    if (missing.length) throw new McpToolError(`No task found with id ${missing.map((m) => `'${m}'`).join(", ")}. Use list_tasks to find task ids.`);

    // Plan every task first, so a bulk edit fails as a whole instead of half-applying.
    const planned: { task: TaskWithRepos; plan: TaskEditPlan }[] = [];
    const errors: string[] = [];
    for (const id of ids) {
      const task = tasks.find((t) => t.id === id)!;
      try {
        planned.push({ task, plan: planTaskEdit(task, args) });
      } catch (err) {
        if (!(err instanceof McpToolError) || ids.length === 1) throw err;
        errors.push(`${id} (${task.title}): ${err.message}`);
      }
    }
    if (errors.length) throw new McpToolError(`No tasks were changed:\n${errors.join("\n")}`);

    // Every task gets the same arguments, so the referenced ids are the same for all.
    const first = planned[0].plan;
    if (first.dependsOnTaskId) {
      const dep = await prisma.task.findUnique({ where: { id: first.dependsOnTaskId }, select: { id: true } });
      if (!dep) throw new McpToolError(`No task found with id '${first.dependsOnTaskId}' (dependsOnTaskId).`);
    }
    if (first.teamId) {
      const team = await prisma.team.findUnique({ where: { id: first.teamId }, select: { id: true } });
      if (!team) throw new McpToolError(`No team found with id '${first.teamId}'. Use list_teams to find team ids.`);
    }
    if (first.aiProviderId) {
      unwrapCheck(await checkProviderUsable(first.aiProviderId));
      for (const { task } of planned) {
        const model = args.model !== undefined ? argString(args, "model") : task.model;
        await assertModelFits(model, first.aiProviderId, ids.length > 1 ? task : undefined);
      }
    }

    // Resolve "use the repo's default branch" before opening the transaction.
    const inputs = await Promise.all(planned.map(async ({ task, plan }) => {
      let repos: { alias: string; url: string; branch: string | null }[] | undefined;
      if (plan.repos) {
        // Repos the caller asked to put on their default branch resolve against the
        // saved repo's defaultBranch, exactly as they would on create.
        const resolved = await resolveRepoBranches(plan.repos.map((r) => ({ url: r.url, branch: r.branch ?? null })));
        repos = plan.repos.map((r, i) => ({
          alias: r.alias,
          url: r.url,
          branch: r.branch === undefined ? resolved[i].branch : r.branch,
        }));
      }
      const data: Prisma.TaskUpdateInput = {
        ...(plan.data as Prisma.TaskUpdateInput),
        ...(repos && { repos: { deleteMany: {}, create: repos } }),
      };
      return { id: task.id, data, changedFields: [...Object.keys(plan.data), ...(repos ? ["repos"] : [])] };
    }));

    const updated = await prisma.$transaction(
      inputs.map(({ id, data }) => prisma.task.update({ where: { id }, data, include: { repos: true } })),
    );

    if (updated.length === 1) {
      return { updated: true, changedFields: inputs[0].changedFields, task: summarizeTask(updated[0]) };
    }
    return {
      updated: updated.length,
      changedFields: inputs[0].changedFields,
      tasks: updated.map((t: TaskWithRepos) => summarizeTask(t)),
    };
  },
};

const startTaskTool: Tool = {
  name: "start_task",
  title: "Start / re-run a task",
  access: "write",
  annotations: { destructiveHint: false, idempotentHint: true },
  description:
    "Queue a task to run now: enables it (if it's in the backlog), clears any schedule or retry backoff and sets it " +
    "pending. Works for backlog tasks and for re-running failed/killed/finished ones. Fails if it's already running, " +
    "and for review-only tasks, which never run.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Task id." } },
    required: ["id"],
    additionalProperties: false,
  },
  async handler(args) {
    const id = argString(args, "id", { required: true });
    const task = unwrap(await startTask(id));
    return { started: true, message: "Task queued — the worker will pick it up shortly.", task: summarizeTask(task) };
  },
};

const cancelTask: Tool = {
  name: "cancel_task",
  title: "Cancel a task",
  access: "write",
  annotations: { destructiveHint: true, idempotentHint: true },
  description:
    "Stop a pending, running, paused or throttled task (same as the Kill button). Work already pushed stays pushed. " +
    "The task can be re-run later with start_task.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id." },
      reason: { type: "string", description: "Recorded in the task log." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = argString(args, "id", { required: true });
    const reason = argString(args, "reason");
    unwrap(await killTask(id, `Task cancelled via MCP (${ctx.tokenName})${reason ? `: ${reason}` : "."}`));
    return { cancelled: true, id };
  },
};

const approveTeamStage: Tool = {
  name: "approve_team_stage",
  title: "Approve a team stage",
  access: "write",
  annotations: { destructiveHint: false, idempotentHint: false },
  description:
    "Decide on a team task that is awaiting_approval — its pipeline stopped after a member marked \"Require approval\" " +
    "(e.g. a Planner) and is waiting for a human before the next member runs. Read the stage's output first with " +
    "get_task (teamProgress) or get_task_logs. decision \"approve\" continues with the next member (feedback = optional " +
    "notes passed to it); \"revise\" re-runs the same member with feedback (required). Only do this when the user asked you to.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id." },
      decision: { type: "string", enum: ["approve", "revise"], description: "approve = continue; revise = redo the stage." },
      feedback: { type: "string", description: "Notes for the next member (approve) or the changes wanted (revise)." },
    },
    required: ["id", "decision"],
    additionalProperties: false,
  },
  async handler(args) {
    const id = argString(args, "id", { required: true });
    const decision = argString(args, "decision", { required: true });
    if (decision !== "approve" && decision !== "revise") throw new McpToolError("'decision' must be \"approve\" or \"revise\".");
    const result = unwrap(await decideTeamApproval(id, decision, argString(args, "feedback") ?? null));
    return { id, ...result, status: "pending" };
  },
};

const sendMessage: Tool = {
  name: "send_task_message",
  title: "Message a task's agent",
  access: "write",
  annotations: { destructiveHint: false, idempotentHint: false },
  description:
    "Send instructions to a task's agent, like the chat box on the task page. Running → delivered to the live " +
    "session. Paused/throttled → added to its context for when it resumes. Finished (completed, failed, killed…) → " +
    "the message becomes a follow-up run of the task, which is re-queued.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id." },
      message: { type: "string", description: "What to tell the agent." },
    },
    required: ["id", "message"],
    additionalProperties: false,
  },
  async handler(args) {
    const id = argString(args, "id", { required: true });
    const message = argString(args, "message", { required: true });
    const outcome = unwrap(await sendTaskMessage(id, message));
    const explanation = {
      sent: "Delivered to the running agent.",
      queued: "The task is paused — the message was added to its context and will be used when it resumes.",
      requeued: "The task had finished, so it was re-queued with your message as its new instructions.",
    }[outcome.mode];
    return { ok: true, mode: outcome.mode, message: explanation };
  },
};

const reviewTask: Tool = {
  name: "review_task",
  title: "Review a task (approve / request changes)",
  access: "write",
  annotations: { destructiveHint: false, idempotentHint: false },
  description:
    "Record a review decision on a finished task. 'approve' marks it reviewed and moves it to Done on the board " +
    "(it does not merge any PR). 'request_changes' re-runs the agent with your feedback as new instructions, " +
    "continuing on the task's existing branch/PR so the fix lands as new commits. 'reopen' moves a Done task back " +
    "to In Review. Inspect the task with get_task first. On a review-only task (reviewOnly: true) approve and reopen work " +
    "the same way, but request_changes is refused — there's no agent run to continue; create a normal task that works " +
    "on the referenced branch instead.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id." },
      decision: { type: "string", enum: ["approve", "request_changes", "reopen"] },
      feedback: {
        type: "string",
        description: "Required for request_changes (the agent's instructions). For approve/reopen it's appended to the task notes.",
      },
    },
    required: ["id", "decision"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = argString(args, "id", { required: true });
    const decision = argEnum(args, "decision", ["approve", "request_changes", "reopen"] as const);
    if (!decision) throw new McpToolError("'decision' is required.");
    const feedback = argString(args, "feedback");
    const task = await requireTask(id);

    const plan = planReviewDecision(task, decision);
    if (plan.kind === "error") throw new McpToolError(plan.message);

    if (plan.kind === "request_changes") {
      if (!feedback) throw new McpToolError("'feedback' is required for request_changes — it becomes the agent's instructions.");
      const updated = unwrap(await requestTaskChanges(id, feedback));
      return {
        ok: true,
        decision,
        message: updated.branchName
          ? `Changes requested — the agent will continue on branch ${updated.branchName}.`
          : "Changes requested — the task was re-queued with your feedback.",
        task: summarizeTask(updated),
      };
    }

    const note = feedback ? `[${decision === "approve" ? "Approved" : "Reopened"} via MCP · ${ctx.tokenName}] ${feedback}` : null;
    const updated = await prisma.task.update({
      where: { id },
      data: {
        reviewStatus: plan.reviewStatus,
        ...(note && { notes: [task.notes, note].filter(Boolean).join("\n\n") }),
      },
      include: { repos: true },
    });
    if (decision === "approve" && task.reviewStatus !== "done") recordTaskReview(id, "approved");
    return {
      ok: true,
      decision,
      message: decision === "approve" ? "Marked as reviewed (moved to Done)." : "Moved back to In Review.",
      task: summarizeTask(updated),
    };
  },
};

const getDocs: Tool = {
  name: "get_docs",
  title: "Read the Task Manager docs",
  access: "read",
  description:
    "The Task Manager's own documentation, as markdown with links and examples for this deployment: the REST API, " +
    "the OpenAI/Anthropic-compatible API (use the Task Manager as a drop-in LLM endpoint) and this MCP server. " +
    "Call it without a topic to list the topics, then with one to read it. Use it to answer setup questions or to " +
    "write code that integrates with the Task Manager.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: DOCS_TOPIC_IDS,
        description: "Which page to read. Omit to list the topics with a one-line summary each.",
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const topic = argEnum(args, "topic", DOCS_TOPIC_IDS);
    if (!topic) return { topics: docsTopicIndex(ctx.origin) };
    // MCP_TOOLS is read at call time, so get_docs documents every tool including itself.
    return renderDocsTopic(topic, ctx.origin, { tools: MCP_TOOLS, prompts: MCP_PROMPTS });
  },
};

export const MCP_TOOLS: Tool[] = [
  listTasks,
  getTask,
  getTaskLogs,
  getTaskStats,
  listTaskFiles,
  readTaskFile,
  listRepositories,
  listTeamsTool,
  listProviders,
  getDocs,
  createTask,
  updateTask,
  startTaskTool,
  cancelTask,
  approveTeamStage,
  sendMessage,
  reviewTask,
];

// ---------------------------------------------------------------------------
// Prompts — canned workflows the user can pick from their MCP client's menu
// (e.g. "/mcp__task-manager__review_task" in Claude Code).
// ---------------------------------------------------------------------------

export const MCP_PROMPTS: McpPromptDefinition[] = [
  {
    name: "review_task",
    title: "Review a task",
    description: "Inspect a finished task (description, logs, PR, test plan) and recommend approve or request changes.",
    access: "read",
    arguments: [{ name: "taskId", description: "The task to review.", required: true }],
    render: ({ taskId }) =>
      `Review task ${taskId} from the AI Task Manager.\n\n` +
      `1. Call get_task with id "${taskId}" (logLines: 60) and read the description, context, PR summary, test plan, ` +
      `CI/merge state and any errors.\n` +
      `2. If something looks off, use get_task_logs (e.g. levels ["error"]) to dig in.\n` +
      `3. Summarise what the agent did, whether it fully met the request, and any risks or gaps.\n` +
      `4. Recommend either approving it or requesting specific changes (draft the feedback). ` +
      `Don't call review_task until I confirm.`,
  },
  {
    name: "board_summary",
    title: "Summarise the board",
    description: "What's running, queued, waiting for review and recently failed.",
    access: "read",
    render: () =>
      `Give me a status update on the AI Task Manager.\n\n` +
      `Call get_task_stats, then list_tasks for the in_progress, in_review and todo board columns (limit 10 each). ` +
      `Summarise: what's running now, what's waiting for my review (oldest first), what's queued next, and anything ` +
      `that failed recently with a one-line reason for each (use get_task_logs with levels ["error"] if needed). Keep it short.`,
  },
  {
    name: "triage_failures",
    title: "Triage failed tasks",
    description: "Find recently failed tasks, explain why each failed and suggest a fix.",
    access: "read",
    arguments: [{ name: "since", description: "ISO date — only failures created after this (default: last 7 days)." }],
    render: ({ since }) =>
      `Triage failed tasks in the AI Task Manager${since ? ` created since ${since}` : " from the last 7 days"}.\n\n` +
      `Use list_tasks with status ["failed", "timedout"]${since ? ` and createdAfter "${since}"` : ""}. For each, read ` +
      `get_task_logs (levels ["error", "system"], limit 50) and explain the root cause in one or two sentences. ` +
      `Group failures with the same cause, and suggest whether to re-run as-is (start_task), re-run with extra ` +
      `instructions (send_task_message), or fix something in settings first. Don't change anything until I confirm.`,
  },
  {
    name: "plan_tasks",
    title: "Break a goal into tasks",
    description: "Turn a larger goal into a set of well-scoped tasks and create them after you approve the plan.",
    access: "write",
    arguments: [
      { name: "goal", description: "What you want to achieve.", required: true },
      { name: "repo", description: "Repository URL (see list_repositories)." },
    ],
    render: ({ goal, repo }) =>
      `Help me turn this goal into tasks for the AI Task Manager:\n\n${goal}\n\n` +
      `${repo ? `Target repository: ${repo}\n\n` : "Call list_repositories to pick the right repository.\n\n"}` +
      `Propose a short list of independent, well-scoped tasks (title + agent-facing description each, and which ones ` +
      `must run after another). Check list_tasks for existing tasks that already cover any of it. Wait for my ` +
      `approval, then create them with create_task (use dependsOnTaskId for ordering).`,
  },
];

export const MCP_INSTRUCTIONS = [
  "You are connected to an AI Task Manager: a queue of tasks that AI coding agents run against Git repositories.",
  "Each task has a description (the agent's instructions), optional context, repos, and a status: pending (queued), " +
    "running, paused/throttled (waiting on a rate limit), awaiting_approval (a team pipeline waiting for a human to " +
    "approve a stage), completed, no_changes, failed, killed or timedout. " +
    "On the board, tasks sit in To Do, In Progress, In Review (finished, awaiting a human) or Done.",
  "To answer questions, use list_tasks (search/filter), get_task (full details + recent logs), get_task_logs, " +
    "get_task_stats, and list_task_files/read_task_file for file outputs. Cite task ids and titles in answers.",
  "Recurring tasks are templates that spawn a run each time their cron schedule fires: list them with list_tasks " +
    "recurringTemplates: true, and their runs with recurringTemplateId.",
  "To leave a reminder to review work done elsewhere (a hand-pushed commit, another session), create_task with " +
    "reviewOnly: true and reviewMetadata (repo, branch, commits, prUrl): it goes straight to In Review and never runs.",
  "For questions about the Task Manager itself (setup, the REST API, the OpenAI/Anthropic-compatible endpoint, " +
    "this MCP server), read its docs with get_docs instead of guessing.",
  "To change things: create_task, update_task, start_task, cancel_task, approve_team_stage, send_task_message, review_task. " +
    "Confirm with the user before cancelling tasks or creating more than a couple of tasks at once.",
].join("\n\n");

export function mcpServerConfig(): McpServerConfig<McpToolContext> {
  return {
    tools: MCP_TOOLS,
    prompts: MCP_PROMPTS,
    instructions: MCP_INSTRUCTIONS,
    onError: (err, tool) => console.error(`[mcp] tool ${tool} failed:`, err),
  };
}
