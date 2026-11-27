// Task mutations shared by more than one entry point.
//
// The public REST API (src/app/api/v1/*), the internal UI routes and the MCP server
// (src/lib/mcp/tools.ts) all create, start, cancel, message and request changes on
// tasks. Each of those used to be written inline in a route; they live here so the MCP
// tools behave exactly like the buttons and endpoints they mirror. Every function
// returns a result object instead of an HTTP response so each caller can shape its own
// error envelope.
import { recordTaskReview } from "./task-evaluation";
import { prisma } from "@/lib/db";
import { normalizePriority } from "@/lib/priority";
import { normalizeEffort } from "@/lib/effort";
import { serializeToolAccess } from "@/lib/agent-tools";
import { normalizeOutputType } from "@/lib/output-type";
import { gitFieldsForMode, resolveRepoBranches, resolveRepoDefaults } from "@/lib/repos";
import { existingTeamId } from "@/lib/teams";
import { AWAITING_APPROVAL_STATUS, approveStage, parseTeamProgress, requestStageRevision, serializeTeamProgress } from "@/lib/team-progress";
import {
  REVIEW_ONLY_CHANGES_REFUSAL,
  REVIEW_ONLY_RUN_REFUSAL,
  parseReviewMetadata,
  planReviewOnlyCreate,
} from "@/lib/review-only";
import type { Task, TaskRepo } from "@/generated/prisma/client";

export type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

function fail(status: number, code: string, message: string): { ok: false; status: number; code: string; message: string } {
  return { ok: false, status, code, message };
}

const FINISHED_STATUSES = new Set(["completed", "no_changes", "failed", "killed", "timedout"]);

export interface CreateTaskInput {
  title?: string;
  description?: string;
  context?: string;
  repos?: { alias?: string; url?: string; branch?: string }[];
  outputType?: string;
  priority?: string;
  effort?: string;
  model?: string;
  labels?: string[];
  pushToMain?: boolean;
  createPR?: boolean;
  targetBranch?: string;
  tokenBudget?: number;
  costBudget?: number;
  autoStart?: boolean;
  toolAccess?: Record<string, boolean>;
  allowSubtasks?: boolean;
  /** Not on the public REST contract; used by MCP. */
  dependsOnTaskId?: string;
  teamId?: string;
  scheduledFor?: Date;
  /** Pin a provider connection. Not on the public REST contract; used by MCP. */
  aiProviderId?: string | null;
  /** Let the Smart Provider Picker choose. Not on the public REST contract; used by MCP. */
  useSmartProvider?: boolean;
  /**
   * Creates a recurring template instead of a one-off task: the worker spawns a run
   * each time the schedule fires. Not on the public REST contract; used by MCP.
   * Must already be validated (see validateCron() in src/lib/mcp/task-update.ts).
   */
  cronExpression?: string;
  /** Cap on the template's cron-triggered runs; null/undefined = unlimited. */
  maxRuns?: number | null;
  /**
   * Create a review-only ticket: it goes straight to In Review and never runs an
   * agent (see src/lib/review-only.ts). Repos and run options don't apply.
   */
  reviewOnly?: boolean;
  /** Review metadata { repo?, branch?, commits?, prUrl? } — validated by parseReviewMetadata(). */
  reviewMetadata?: unknown;
  /** Private notes (not shown to an agent). */
  notes?: string;
}

/**
 * Creates a task the way POST /api/v1/tasks does: validates, applies the saved-repo
 * defaults (branch per repo, "after task completes" mode when the caller chose none),
 * and appends it to the end of the queue.
 */
export async function createTaskFromInput(input: CreateTaskInput): Promise<ActionResult<Task & { repos: TaskRepo[] }>> {
  const {
    title, description, context, repos = [], outputType, priority, effort, model, labels,
    pushToMain, createPR, targetBranch, tokenBudget, costBudget, autoStart = true,
    toolAccess, allowSubtasks = false, dependsOnTaskId, teamId, scheduledFor,
    aiProviderId, useSmartProvider, cronExpression, maxRuns, reviewOnly, reviewMetadata, notes,
  } = input;
  const recurring = Boolean(cronExpression?.trim());

  if (!description || !description.trim()) {
    return fail(400, "invalid_request", "'description' is required.");
  }

  const meta = parseReviewMetadata(reviewMetadata);
  if (!meta.ok) return fail(400, "invalid_request", meta.message);
  if (reviewOnly) return createReviewOnlyTask(input);
  if (Object.keys(meta.columns).length) {
    return fail(400, "invalid_request", "'reviewMetadata' only applies to review-only tasks — pass reviewOnly: true.");
  }

  const resolvedOutputType = normalizeOutputType(outputType);
  const cleanRepos = (Array.isArray(repos) ? repos : []).filter((r) => r?.url);
  if (resolvedOutputType === "repository" && cleanRepos.length === 0) {
    return fail(
      400,
      "invalid_request",
      "At least one repo (`repos: [{ alias, url }]`) is required unless `outputType` is 'file', 'design' or 'result'.",
    );
  }

  if (dependsOnTaskId) {
    const dep = await prisma.task.findUnique({ where: { id: dependsOnTaskId }, select: { id: true } });
    if (!dep) return fail(404, "not_found", `No task found with id '${dependsOnTaskId}' (dependsOnTaskId).`);
  }
  if (teamId) {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!team) return fail(404, "not_found", `No team found with id '${teamId}'.`);
  }
  if (aiProviderId) {
    const providerError = await checkProviderUsable(aiProviderId);
    if (providerError) return providerError;
  }
  if (recurring && scheduledFor) {
    return fail(400, "invalid_request", "A recurring task runs on its cron schedule; 'scheduledFor' can't be combined with it.");
  }

  // Saved-repo git defaults (Repositories page): each repo without a branch is
  // cloned at its default branch, and the default "after task completes" mode
  // applies when the caller set none of pushToMain / createPR / targetBranch.
  const repoDefaults = await resolveRepoDefaults(cleanRepos.map((r) => r.url));
  const gitChosen = pushToMain !== undefined || createPR !== undefined || targetBranch !== undefined;
  const gitFields = !gitChosen && repoDefaults.defaultGitMode
    ? gitFieldsForMode(repoDefaults.defaultGitMode, repoDefaults.defaultTargetBranch)
    : { pushToMain: Boolean(pushToMain), createPR: Boolean(createPR), targetBranch: targetBranch?.trim() || null };
  const resolvedRepos = await resolveRepoBranches(cleanRepos.map((r) => ({ ...r, branch: r.branch?.trim() })));
  // The repo's default team applies when the caller didn't pass `teamId` at all
  // (null/"" = explicitly no team). A since-deleted default team is dropped.
  const resolvedTeamId = teamId === undefined
    ? await existingTeamId(repoDefaults.defaultTeamId)
    : (teamId || null);
  // Provider and Smart Provider are one choice: a caller that set either one made it,
  // so the repo's default provider only applies when both were left out (as in POST /api/tasks).
  const providerChosen = aiProviderId !== undefined || useSmartProvider !== undefined;
  const resolvedSmart = Boolean(providerChosen ? useSmartProvider : repoDefaults.defaultUseSmartProvider);
  const resolvedProviderId = resolvedSmart ? null : ((providerChosen ? aiProviderId : repoDefaults.defaultAiProviderId) || null);

  const maxPos = await prisma.task.aggregate({ _max: { position: true } });
  const position = (maxPos._max.position ?? -1) + 1;

  const task = await prisma.task.create({
    data: {
      title: (title?.trim() || description.trim().slice(0, 80)),
      description: description.trim(),
      context: context?.trim() || null,
      position,
      priority: normalizePriority(priority),
      effort: normalizeEffort(effort),
      toolAccess: serializeToolAccess(toolAccess),
      allowSubtasks: Boolean(allowSubtasks),
      outputType: resolvedOutputType,
      pushToMain: gitFields.pushToMain,
      targetBranch: gitFields.targetBranch,
      createPR: gitFields.createPR,
      tokenBudget: tokenBudget ? Number(tokenBudget) : null,
      costBudget: costBudget ? Number(costBudget) : null,
      model: model?.trim() || null,
      labels: Array.isArray(labels) && labels.length > 0 ? JSON.stringify(labels) : null,
      notes: notes?.trim() ? notes : null,
      dependsOnTaskId: dependsOnTaskId || null,
      teamId: resolvedTeamId,
      scheduledFor: scheduledFor ?? null,
      aiProviderId: resolvedProviderId,
      useSmartProvider: resolvedSmart,
      // A recurring template never runs itself; the worker spawns an instance each
      // time the cron fires, so `autoStart` means "schedule active" for one.
      isRecurringTemplate: recurring,
      cronExpression: recurring ? cronExpression!.trim() : null,
      maxRuns: recurring ? (maxRuns ?? null) : null,
      // `autoStart: false` creates the task "parked" — isEnabled=false keeps the worker
      // from ever picking it up until it's started explicitly. Default is true so a
      // single create call behaves like every other task-creation path.
      isEnabled: Boolean(autoStart),
      repos: {
        create: resolvedRepos.map((r) => ({
          alias: r.alias?.trim() || (r.url!.split("/").pop()?.replace(/\.git$/, "") || "repo"),
          url: r.url!.trim(),
          branch: r.branch,
        })),
      },
    },
    include: { repos: true },
  });

  return { ok: true, value: task };
}

/**
 * A review-only ticket: straight into In Review, never picked up by the worker.
 * Validation and columns come from the pure planReviewOnlyCreate() (unit-tested).
 */
async function createReviewOnlyTask(input: CreateTaskInput): Promise<ActionResult<Task & { repos: TaskRepo[] }>> {
  const plan = planReviewOnlyCreate(input);
  if (!plan.ok) return fail(400, "invalid_request", plan.message);

  const maxPos = await prisma.task.aggregate({ _max: { position: true } });
  const task = await prisma.task.create({
    data: {
      ...plan.data,
      position: (maxPos._max.position ?? -1) + 1,
      priority: normalizePriority(input.priority),
    },
    include: { repos: true },
  });
  return { ok: true, value: task };
}

/**
 * Why a task can't be pinned to this provider connection, or null when it can.
 * Disabled connections are never used by anything (see CLAUDE.md), so pinning one
 * would only look like a choice.
 */
export async function checkProviderUsable(id: string): Promise<{ ok: false; status: number; code: string; message: string } | null> {
  const provider = await prisma.aIProvider.findUnique({ where: { id }, select: { name: true, isEnabled: true } });
  if (!provider) return fail(404, "not_found", `No provider found with id '${id}'. Use list_providers to see them.`);
  if (!provider.isEnabled) {
    return fail(400, "invalid_request", `Provider '${provider.name}' is disabled, so it would never run the task. Enable it in Settings → AI, or pick another.`);
  }
  return null;
}

/**
 * Re-queues a non-running task as pending + enabled, clearing a schedule or retry
 * backoff so the worker picks it up on its next poll.
 */
export async function startTask(id: string): Promise<ActionResult<Task & { repos: TaskRepo[] }>> {
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return fail(404, "not_found", `No task found with id '${id}'.`);
  if (task.isRecurringTemplate) {
    return fail(400, "invalid_request", "This is a recurring template, not a runnable task. Use its instances instead.");
  }
  if (task.status === "running") return fail(409, "already_running", "Task is already running.");
  if (task.reviewOnly) return fail(409, "review_only", REVIEW_ONLY_RUN_REFUSAL);

  const updated = await prisma.task.update({
    where: { id },
    data: { isEnabled: true, status: "pending", nextRetryAt: null, scheduledFor: null },
    include: { repos: true },
  });
  return { ok: true, value: updated };
}

/** Same as the "Kill Task" button: the worker stops the agent once it sees `killed`. */
export async function killTask(id: string, reason = "Task killed by user."): Promise<ActionResult<null>> {
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return fail(404, "not_found", `No task found with id '${id}'.`);
  if (task.status === "completed" || task.status === "no_changes" || task.status === "failed" || task.status === "killed") {
    return fail(400, "already_finished", "Task is already finished");
  }
  await prisma.$transaction([
    prisma.task.update({ where: { id }, data: { status: "killed" } }),
    prisma.taskLog.create({ data: { taskId: id, content: reason, level: "system" } }),
  ]);
  return { ok: true, value: null };
}

export type MessageOutcome =
  /** Injected into the running agent session. */
  | { mode: "sent"; messageId: string }
  /** Task is paused/throttled — folded into its context for the resume. */
  | { mode: "queued" }
  /** Task had finished — re-queued with the message as its new instructions. */
  | { mode: "requeued" };

/**
 * The task-detail chat box. What happens depends on the task's state:
 * running → delivered to the live session; paused/throttled → appended to the context
 * used when it resumes; finished → the message becomes a follow-up run.
 */
export async function sendTaskMessage(id: string, content: string): Promise<ActionResult<MessageOutcome>> {
  const text = content?.trim();
  if (!text) return fail(400, "invalid_request", "content is required");

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return fail(404, "not_found", `No task found with id '${id}'.`);

  if (task.status === "running") {
    const message = await prisma.taskMessage.create({ data: { taskId: id, content: text } });
    // Log immediately so the message shows up right away in the live log/chat
    // view via SSE — don't wait for the worker to pick it up via
    // getNextMessage(), which only happens between turns for providers that
    // support live injection (API/OpenAI) and never happens at all for the
    // CLI provider (it runs a single non-interactive `claude -p` invocation).
    await prisma.taskLog.create({ data: { taskId: id, content: text, level: "user" } });
    return { ok: true, value: { mode: "sent", messageId: message.id } };
  }

  if (task.status === "paused" || task.status === "throttled" || task.status === AWAITING_APPROVAL_STATUS) {
    // The task isn't running (the worker isn't attached to a live process for it),
    // so there's nothing to inject a message into right now. Instead, fold the
    // extra instructions into the task's context so they're included the next
    // time the worker builds the resume prompt — which happens automatically
    // once the rate limit / throttle window lifts (see nextRetryAt). Leave
    // status and nextRetryAt untouched so the existing auto-resume keeps working.
    const updatedContext = [
      task.context,
      `### Additional instructions (added while task was ${task.status})\n${text}`,
    ].filter(Boolean).join("\n\n");
    await prisma.task.update({ where: { id }, data: { context: updatedContext } });
    await prisma.taskLog.create({ data: { taskId: id, content: text, level: "user" } });
    return { ok: true, value: { mode: "queued" } };
  }

  if (task.reviewOnly) return fail(409, "review_only", REVIEW_ONLY_RUN_REFUSAL);

  if (FINISHED_STATUSES.has(task.status)) {
    const previousParts = [
      `Previous task: ${task.description}`,
      task.context ? `Previous context: ${task.context}` : null,
    ].filter(Boolean).join("\n\n");
    await prisma.task.update({
      where: { id },
      data: {
        description: text,
        context: previousParts,
        status: "pending",
        nextRetryAt: null,
        prSummary: null,
      },
    });
    await prisma.taskLog.create({ data: { taskId: id, content: text, level: "user" } });
    return { ok: true, value: { mode: "requeued" } };
  }

  return fail(409, "invalid_state", "task is not in a state that accepts messages");
}

/**
 * "Request changes": re-runs the task with the change as its new description,
 * continuing on the same branch (and PR) so the change lands as new commits on top
 * of the existing work instead of starting over.
 */
export async function requestTaskChanges(id: string, description: string): Promise<ActionResult<Task & { repos: TaskRepo[] }>> {
  const text = description?.trim();
  if (!text) return fail(400, "invalid_request", "description is required");

  const task = await prisma.task.findUnique({ where: { id }, include: { repos: true } });
  if (!task) return fail(404, "not_found", `No task found with id '${id}'.`);
  if (task.reviewOnly) return fail(409, "review_only", REVIEW_ONLY_CHANGES_REFUSAL);

  // Tasks with a branch (the normal git-repo flow) continue on that same branch so the
  // change lands as new commits on top of the existing work/PR. Tasks with no branch —
  // e.g. file-output tasks, which never push one — just get a fresh run of the same task
  // with the change folded in; any previously produced output is still on disk in the
  // task's workspace for the agent to build on.
  const contextParts = task.branchName
    ? [
        `Change request continuing on the existing branch \`${task.branchName}\`.`,
        `## Original Task Description`,
        task.description,
      ]
    : [
        `Change request for a follow-up run of this task (no existing branch/PR to continue on).`,
        `## Original Task Description`,
        task.description,
      ];
  if (task.context) contextParts.push(`## Original Context`, task.context);

  const updated = await prisma.task.update({
    where: { id },
    data: {
      description: text,
      context: contextParts.join("\n\n"),
      status: "pending",
      reviewStatus: null,
      // Increment (never reset to 0) so the worker treats this as a resume:
      // retryCount > 0 makes it reuse the existing on-disk clone / re-clone the
      // agent's own branch instead of re-cloning fresh from the base branch and
      // force-pushing over the work that's already been done (see rebase-branch
      // route, which follows the same pattern).
      retryCount: { increment: 1 },
      nextRetryAt: null,
    },
    include: { repos: true },
  });
  recordTaskReview(id, "changes_requested");
  return { ok: true, value: updated };
}

export type TeamApprovalDecision = "approve" | "revise";

/**
 * Decide on a team stage that is waiting for manual approval (a member with
 * "Require approval" ticked on the Teams page). `approve` lets the pipeline continue
 * with the next member — `feedback` is optional and handed to that member as notes;
 * `revise` re-runs the same member with `feedback` (required) and its previous output.
 * Either way the task is re-queued; retryCount is bumped so the worker reuses the
 * existing workspace and picks up from the recorded progress (see planTeamResume()).
 */
export async function decideTeamApproval(
  id: string,
  decision: TeamApprovalDecision,
  feedback?: string | null,
): Promise<ActionResult<{ stage: string; decision: TeamApprovalDecision }>> {
  if (decision !== "approve" && decision !== "revise") {
    return fail(400, "invalid_request", "decision must be \"approve\" or \"revise\"");
  }
  const task = await prisma.task.findUnique({ where: { id }, select: { id: true, status: true, teamProgress: true } });
  if (!task) return fail(404, "not_found", `No task found with id '${id}'.`);
  if (task.status !== AWAITING_APPROVAL_STATUS) {
    return fail(409, "invalid_state", "Task is not waiting for approval.");
  }
  const progress = parseTeamProgress(task.teamProgress);
  if (!progress) return fail(409, "invalid_state", "Task has no recorded team progress to approve.");

  const now = new Date();
  const text = feedback?.trim() || null;
  const decided = decision === "approve"
    ? approveStage(progress, now, text)
    : text
      ? requestStageRevision(progress, text)
      : null;
  if (!decided) {
    if (decision === "revise" && !text) return fail(400, "invalid_request", "Describe the changes you want (feedback is required to request a revision).");
    return fail(409, "invalid_state", "No team stage is waiting for approval.");
  }
  const stage = decided.progress.stages[decided.index].name;
  const logLine = decision === "approve"
    ? `Approved the "${stage}" stage — the team pipeline will continue.${text ? `\n\nNotes: ${text}` : ""}`
    : `Requested changes to the "${stage}" stage — it will run again with this feedback:\n\n${text}`;

  // Only move the task if it is still waiting — guards against two decisions racing.
  const updated = await prisma.task.updateMany({
    where: { id, status: AWAITING_APPROVAL_STATUS },
    data: {
      status: "pending",
      isEnabled: true,
      nextRetryAt: null,
      retryCount: { increment: 1 },
      teamProgress: serializeTeamProgress(decided.progress),
    },
  });
  if (updated.count === 0) return fail(409, "invalid_state", "Task is no longer waiting for approval.");
  await prisma.taskLog.create({ data: { taskId: id, content: logLine, level: "user", member: stage } });
  return { ok: true, value: { stage, decision } };
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  context?: string | null;
  priority?: string;
  labels?: string[] | null;
  notes?: string | null;
  /** Review-only tasks: { repo?, branch?, commits?, prUrl? } — only the keys passed change. */
  reviewMetadata?: unknown;
}

/**
 * The public API's PATCH /api/v1/tasks/[id]: edits the ticket fields every task has
 * (title, description, context, priority, labels, notes) and, on a review-only task,
 * its review metadata. Run settings stay with the UI's edit form and MCP update_task.
 */
export async function updateTaskFromInput(id: string, input: UpdateTaskInput): Promise<ActionResult<Task & { repos: TaskRepo[] }>> {
  const task = await prisma.task.findUnique({ where: { id }, select: { id: true, status: true, reviewOnly: true, description: true } });
  if (!task) return fail(404, "not_found", `No task found with id '${id}'.`);

  const meta = parseReviewMetadata(input.reviewMetadata);
  if (!meta.ok) return fail(400, "invalid_request", meta.message);
  if (Object.keys(meta.columns).length && !task.reviewOnly) {
    return fail(400, "invalid_request", "'reviewMetadata' only applies to review-only tasks.");
  }
  if (task.status === "running" && (input.description !== undefined || input.context !== undefined)) {
    return fail(409, "invalid_state", "The task is running, so its description and context can't change — the agent already read them.");
  }
  if (input.description !== undefined && (typeof input.description !== "string" || !input.description.trim())) {
    return fail(400, "invalid_request", "'description' can't be empty.");
  }
  if (input.labels !== undefined && input.labels !== null && (!Array.isArray(input.labels) || !input.labels.every((l) => typeof l === "string"))) {
    return fail(400, "invalid_request", "'labels' must be an array of strings.");
  }

  const data: Record<string, unknown> = { ...meta.columns };
  if (input.title !== undefined) {
    const t = typeof input.title === "string" ? input.title.trim() : "";
    // Same default as create: an empty title falls back to the description.
    data.title = t || (input.description ?? task.description).trim().slice(0, 80);
  }
  if (input.description !== undefined) data.description = input.description.trim();
  if (input.context !== undefined) data.context = typeof input.context === "string" && input.context.trim() ? input.context.trim() : null;
  if (input.priority !== undefined) data.priority = normalizePriority(input.priority);
  if (input.labels !== undefined) data.labels = input.labels && input.labels.length ? JSON.stringify(input.labels) : null;
  if (input.notes !== undefined) data.notes = typeof input.notes === "string" && input.notes.length ? input.notes : null;
  if (Object.keys(data).length === 0) return fail(400, "invalid_request", "Nothing to update — pass at least one field to change.");

  const updated = await prisma.task.update({ where: { id }, data, include: { repos: true } });
  return { ok: true, value: updated };
}
