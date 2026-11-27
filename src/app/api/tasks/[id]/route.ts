import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cleanWorkspacesInBackground } from "@/lib/workspace";
import { normalizePriority } from "@/lib/priority";
import { normalizeEffort } from "@/lib/effort";
import { serializeToolAccess } from "@/lib/agent-tools";
import { normalizeOutputType } from "@/lib/output-type";
import { normalizeMaxRuns } from "@/lib/max-runs";
import { revalidateThrottledProviders } from "@/lib/provider-throttle";
import { deriveAlias } from "@/lib/repos";
import { recordTaskReview } from "@/lib/task-evaluation";
import { REVIEW_ONLY_RUN_REFUSAL, parseReviewMetadata } from "@/lib/review-only";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await prisma.task.findUnique({
    where: { id },
    include: { repos: true, logs: { orderBy: { createdAt: "asc" } }, dependsOn: { select: { id: true, title: true, status: true } }, dependents: { select: { id: true, title: true, status: true } }, team: { select: { id: true, name: true } } },
  });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(task);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { status, position, priority, effort, nextRetryAt, retryCount, isEnabled, isHailMary, title, description, context, cronExpression, maxRuns, resetRunCount, scheduledFor, repos, pushToMain, targetBranch, createPR, tokenBudget, costBudget, attachments, attachmentsFolder, contextFiles, aiProviderId, useSmartProvider, model, dependsOnTaskId, teamId, notes, labels, systemPrompt, createValidationTask, allowSubtasks, reviewStatus, outputType, resetLastScheduledAt, toolAccess, reviewMetadata, hiddenOnBoard } = body;

  // Review-only tickets (src/lib/review-only.ts) never run: refuse anything that
  // would queue one, and validate their review metadata.
  const reviewMeta = parseReviewMetadata(reviewMetadata);
  if (!reviewMeta.ok) return NextResponse.json({ error: reviewMeta.message, field: reviewMeta.field }, { status: 400 });
  if (reviewMetadata != null || (status !== undefined && status !== "completed") || isHailMary) {
    const current = await prisma.task.findUnique({ where: { id }, select: { reviewOnly: true } });
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (current.reviewOnly && ((status !== undefined && status !== "completed") || isHailMary)) {
      return NextResponse.json({ error: REVIEW_ONLY_RUN_REFUSAL }, { status: 409 });
    }
    if (!current.reviewOnly && reviewMetadata != null) {
      return NextResponse.json({ error: "reviewMetadata only applies to review-only tasks." }, { status: 400 });
    }
  }

  if (status === "pending") {
    await prisma.taskLog.deleteMany({ where: { taskId: id } });
    // Resume / retry / un-backlog all land here. If a provider is carrying a throttle from an
    // earlier limit, check whether it still holds before the worker picks this task up —
    // otherwise the pre-flight check re-parks the task as "throttled" seconds after the user
    // asked for it to run, on the strength of a flag nobody has re-examined.
    await revalidateThrottledProviders().catch(() => {});
  }

  // The edit form sends the full repo list; replace the task's repos with it.
  const nextRepos = Array.isArray(repos)
    ? (repos as { alias?: string; url?: string; branch?: string | null }[])
        .filter((r) => typeof r?.url === "string" && r.url.trim())
        .map((r) => ({
          alias: String(r.alias ?? "").trim() || deriveAlias(r.url!),
          url: r.url!.trim(),
          branch: r.branch?.trim() || null,
        }))
    : undefined;

  if (outputType !== undefined && normalizeOutputType(outputType) === "repository") {
    const repoCount = nextRepos ? nextRepos.length : await prisma.taskRepo.count({ where: { taskId: id } });
    if (repoCount === 0) {
      return NextResponse.json(
        { error: "At least one Git repository is required for \"Commit to repository\" tasks" },
        { status: 400 }
      );
    }
  }

  // Disabling a task ("Move to Backlog" / the Kanban Disable toggle) only sets
  // isEnabled=false, which the worker's poll query checks before ever picking a task
  // up. That's not enough if the task is already running: the worker only stops an
  // in-flight agent process when status flips to "killed" (see isCancelled() in
  // src/worker/index.ts), so an isEnabled=false task that's mid-execution used to run
  // to completion regardless. Mirror the explicit Kill Task action here so disabling a
  // running task actually stops it instead of merely hiding it from the board.
  // Marking a finished task "done" is a person approving its work (human_review evaluation).
  const approving = reviewStatus === "done"
    && (await prisma.task.findUnique({ where: { id }, select: { reviewStatus: true } }))?.reviewStatus !== "done";

  let shouldKillRunning = false;
  if (isEnabled === false && status === undefined) {
    const runningCheck = await prisma.task.findUnique({ where: { id }, select: { status: true } });
    if (runningCheck?.status === "running") shouldKillRunning = true;
  }

  const data = {
    ...(status !== undefined && { status }),
    ...(shouldKillRunning && { status: "killed" }),
    // A re-queue wipes the logs above, so drop the previous team run's progress with them.
    ...(status === "pending" && { teamProgress: null }),
    ...(position !== undefined && { position }),
    ...(priority !== undefined && { priority: normalizePriority(priority) }),
    ...(effort !== undefined && { effort: normalizeEffort(effort) }),
    ...(toolAccess !== undefined && { toolAccess: serializeToolAccess(toolAccess) }),
    ...(nextRetryAt !== undefined && { nextRetryAt: nextRetryAt === null ? null : new Date(nextRetryAt) }),
    ...(retryCount !== undefined && { retryCount }),
    ...(isEnabled !== undefined && { isEnabled }),
    ...(isHailMary !== undefined && { isHailMary: Boolean(isHailMary) }),
    ...(hiddenOnBoard !== undefined && { hiddenOnBoard: Boolean(hiddenOnBoard) }),
    ...(title !== undefined && { title: (typeof title === "string" && title.trim()) ? title.trim() : (typeof description === "string" && description.trim() ? description.trim().slice(0, 80) : title) }),
    ...(description !== undefined && { description }),
    ...(context !== undefined && { context: context || null }),
    ...(cronExpression !== undefined && { cronExpression: cronExpression || null }),
    // null/blank/0 => unlimited. Clearing the cron schedule also clears the run cap so a
    // task converted back to one-off doesn't keep a stale limit around.
    ...(maxRuns !== undefined && { maxRuns: normalizeMaxRuns(maxRuns) }),
    ...(cronExpression !== undefined && !cronExpression && maxRuns === undefined && { maxRuns: null }),
    ...(resetRunCount && { runCount: 0 }),
    ...(scheduledFor !== undefined && { scheduledFor: scheduledFor === null || scheduledFor === "" ? null : new Date(scheduledFor) }),
    ...(pushToMain !== undefined && { pushToMain: Boolean(pushToMain) }),
    ...(targetBranch !== undefined && { targetBranch: targetBranch || null }),
    ...(createPR !== undefined && { createPR: Boolean(createPR) }),
    ...(tokenBudget !== undefined && { tokenBudget: tokenBudget === null || tokenBudget === "" ? null : Number(tokenBudget) }),
    ...(costBudget !== undefined && { costBudget: costBudget === null || costBudget === "" ? null : Number(costBudget) }),
    ...(attachments !== undefined && { attachments: attachments === null ? null : JSON.stringify(attachments) }),
    ...(attachmentsFolder !== undefined && {
      attachmentsFolder: attachmentsFolder === null || attachmentsFolder === ""
        ? null
        : String(attachmentsFolder).trim().replace(/^\/+|\/+$/g, "") || null,
    }),
    ...(contextFiles !== undefined && {
      contextFiles: contextFiles === null || !Array.isArray(contextFiles) || contextFiles.length === 0
        ? null
        : JSON.stringify(
            (contextFiles as { repoAlias?: string; path?: string }[])
              .map((f) => ({
                repoAlias: String(f.repoAlias ?? "").trim(),
                path: String(f.path ?? "").trim().replace(/^\/+|\/+$/g, ""),
              }))
              .filter((f) => f.path)
          ),
    }),
    ...(aiProviderId !== undefined && { aiProviderId: useSmartProvider ? null : (aiProviderId || null) }),
    ...(useSmartProvider !== undefined && { useSmartProvider: Boolean(useSmartProvider) }),
    ...(model !== undefined && { model: model?.trim() || null }),
    ...(dependsOnTaskId !== undefined && { dependsOnTaskId: dependsOnTaskId || null }),
    ...(teamId !== undefined && { teamId: teamId || null }),
    ...(notes !== undefined && { notes: notes === null ? null : String(notes) }),
    ...(labels !== undefined && { labels: labels === null ? null : JSON.stringify(labels) }),
    ...(systemPrompt !== undefined && { systemPrompt: systemPrompt === null || systemPrompt === "" ? null : String(systemPrompt) }),
    ...(createValidationTask !== undefined && { createValidationTask: Boolean(createValidationTask) }),
    ...(allowSubtasks !== undefined && { allowSubtasks: Boolean(allowSubtasks) }),
    ...(reviewStatus !== undefined && { reviewStatus: reviewStatus || null }),
    ...(outputType !== undefined && { outputType: normalizeOutputType(outputType) }),
    ...(resetLastScheduledAt && { lastScheduledAt: new Date() }),
    ...(nextRepos && { repos: { deleteMany: {}, create: nextRepos } }),
    ...reviewMeta.columns,
  };

  const task = shouldKillRunning
    ? (await prisma.$transaction([
        prisma.task.update({
          where: { id },
          data,
          include: { repos: true, dependsOn: { select: { id: true, title: true, status: true } } },
        }),
        prisma.taskLog.create({
          data: { taskId: id, content: "Task killed: disabled while running.", level: "system" },
        }),
      ]))[0]
    : await prisma.task.update({
        where: { id },
        data,
        include: { repos: true, dependsOn: { select: { id: true, title: true, status: true } } },
      });
  if (approving) recordTaskReview(id, "approved");
  return NextResponse.json(task);
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Explicitly null out self-referential FKs before deleting to avoid constraint
    // issues with SQLite's foreign key handling in the better-sqlite3 adapter.
    await prisma.task.updateMany({ where: { recurringTemplateId: id }, data: { recurringTemplateId: null } });
    await prisma.task.updateMany({ where: { dependsOnTaskId: id }, data: { dependsOnTaskId: null } });
    await prisma.task.delete({ where: { id } });
    // Don't block the response on removing the on-disk clone — it can take
    // minutes for big repos and the user only cares that the task is gone.
    cleanWorkspacesInBackground([id]);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("Failed to delete task:", error);
    return NextResponse.json({ error: "Failed to delete task" }, { status: 500 });
  }
}
