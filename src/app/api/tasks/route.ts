import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getProvider } from "@/lib/smart-provider";
import { normalizePriority } from "@/lib/priority";
import { normalizeEffort } from "@/lib/effort";
import { serializeToolAccess } from "@/lib/agent-tools";
import { normalizeOutputType } from "@/lib/output-type";
import { normalizeMaxRuns } from "@/lib/max-runs";
import { gitFieldsForMode, resolveRepoBranches, resolveRepoDefaults } from "@/lib/repos";
import { existingTeamId } from "@/lib/teams";
import { createTaskFromInput } from "@/lib/task-actions";
import { reviewSearchClauses } from "@/lib/review-only";

type TaskWithProvider = { aiProvider?: { isEnabled?: boolean } | null; [key: string]: unknown };

/**
 * Which provider to *show* for a task. A pinned connection that's since been disabled won't be
 * the one that runs it — the worker falls through to smart pick → default → any enabled
 * provider — so listing it would make a switched-off connection look like it's still in use.
 * Fall back to the resolved provider exactly as we do for a task with nothing pinned.
 */
function displayProvider(task: TaskWithProvider, resolved: unknown) {
  const pinned = task.aiProvider;
  if (pinned && pinned.isEnabled !== false) return pinned;
  return resolved ?? null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  const q = searchParams.get("q")?.trim();

  if (q) {
    const tasks = await prisma.task.findMany({
      where: {
        OR: [
          { title: { contains: q } },
          { description: { contains: q } },
          { context: { contains: q } },
          // Commit SHAs and PR URLs (review metadata and agent PRs/commits).
          ...reviewSearchClauses(q),
        ],
      },
      include: { repos: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    return NextResponse.json(tasks);
  }

  if (type === "recurring-templates") {
    const [tasks, defaultProvider] = await Promise.all([
      prisma.task.findMany({
        where: { isRecurringTemplate: true },
        include: { repos: true, aiProvider: { select: { name: true, type: true, model: true, isEnabled: true } } },
        orderBy: [{ isEnabled: "desc" }, { createdAt: "desc" }],
      }),
      getProvider().then((r) => r.provider),
    ]);
    return NextResponse.json(tasks.map((t: TaskWithProvider) => ({ ...t, aiProvider: displayProvider(t, defaultProvider) })));
  }

  const [tasks, defaultProvider] = await Promise.all([
    prisma.task.findMany({
      where: { isRecurringTemplate: false },
      include: {
        repos: true,
        logs: { orderBy: { createdAt: "desc" }, take: 1 },
        dependsOn: { select: { id: true, title: true, status: true } },
        aiProvider: { select: { name: true, type: true, model: true, isEnabled: true } },
        team: { select: { id: true, name: true } },
        // Top-level file entries only (a task's output files live inside a single
        // wrapper folder, so this is normally just that one folder). Without this,
        // the Kanban board's "View files" link loses the file id on every poll
        // refresh — since this route backs that polling — and falls back to the
        // generic /files listing instead of the output folder.
        files: { where: { parentId: null }, select: { id: true, isFolder: true }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    getProvider().then((r) => r.provider),
  ]);

  const result = tasks.map((t: TaskWithProvider) => ({
    ...t,
    aiProvider: displayProvider(t, defaultProvider),
  }));

  return NextResponse.json(result);
}

export async function DELETE() {
  await prisma.task.deleteMany({ where: { isRecurringTemplate: false } });
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { title, description, context, repos = [], scheduledFor, cronExpression, maxRuns, isRecurringTemplate = false, pushToMain, targetBranch, createPR, isEnabled = true, tokenBudget, costBudget, attachments, attachmentsFolder, contextFiles, aiProviderId, useSmartProvider, model, dependsOnTaskId, teamId, labels, systemPrompt, createValidationTask, allowSubtasks, outputType = "repository", priority, effort, toolAccess } = body;

  if (!description) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }

  // Review-only ticket: straight into In Review, never run (src/lib/review-only.ts).
  // Shares createTaskFromInput() with the public API and MCP so validation matches.
  if (body.reviewOnly) {
    const result = await createTaskFromInput({
      title, description, context, labels, priority,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      reviewOnly: true,
      reviewMetadata: body.reviewMetadata,
    });
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status });
    return NextResponse.json(result.value, { status: 201 });
  }
  if (body.reviewMetadata !== undefined && body.reviewMetadata !== null) {
    return NextResponse.json({ error: "reviewMetadata only applies to review-only tasks (reviewOnly: true)." }, { status: 400 });
  }
  const resolvedOutputType = normalizeOutputType(outputType);
  if (resolvedOutputType === "repository" && !repos.some((r: { url?: string }) => r?.url)) {
    return NextResponse.json(
      { error: "At least one Git repository is required for \"Commit to repository\" tasks" },
      { status: 400 }
    );
  }
  // Title is required in the DB but can be auto-derived from description
  const resolvedTitle = title || description.slice(0, 80);

  const maxPos = await prisma.task.aggregate({ _max: { position: true } });
  const position = (maxPos._max.position ?? -1) + 1;

  // A repo saved on the Repositories page can carry defaults for the settings
  // the new-task form groups under "Advanced Options" (priority, effort,
  // budgets, provider, model, labels, follow-up validation task).
  //
  // A default only applies to a field the caller left out entirely
  // (`undefined`). An explicit value — including `null` / `""` / `[]`, which
  // the new-task form sends for options the user deliberately cleared — always
  // wins. That keeps headless creation paths (API calls, webhooks, inbound
  // email, Slack) inheriting the repo's defaults without ever overriding a
  // choice someone actually made.
  const repoDefaults = await resolveRepoDefaults((repos as { url?: string }[]).map((r) => r?.url));
  const fromCaller = <T,>(value: T | undefined, repoDefault: T | undefined): T | undefined =>
    value === undefined ? repoDefault : value;

  // Priority keeps treating null/"" as "unspecified" too — headless callers
  // have always been able to pass an empty priority to mean "use the default".
  const resolvedPriority =
    priority !== undefined && priority !== null && priority !== ""
      ? normalizePriority(priority)
      : normalizePriority(repoDefaults.defaultPriority);

  const resolvedTokenBudget = fromCaller(tokenBudget, repoDefaults.defaultTokenBudget);
  const resolvedCostBudget = fromCaller(costBudget, repoDefaults.defaultCostBudget);
  const resolvedLabels = fromCaller(labels, repoDefaults.defaultLabels);
  const resolvedModel = fromCaller(model, repoDefaults.defaultModel);
  const resolvedCreateValidationTask = fromCaller(createValidationTask, repoDefaults.defaultCreateValidationTask);
  const resolvedAllowSubtasks = fromCaller(allowSubtasks, repoDefaults.defaultAllowSubtasks);
  // A repo can run its tasks through a team by default. `teamId: null` (the
  // form's "Use a team" switched off) opts out; a team deleted since the
  // default was saved is dropped rather than failing the insert.
  const resolvedTeamId = teamId === undefined
    ? await existingTeamId(repoDefaults.defaultTeamId)
    : (teamId || null);
  // Provider and Smart Provider are picked together — a caller that specifies
  // either one has chosen how this task gets its provider, so neither repo
  // default applies.
  const providerChosen = aiProviderId !== undefined || useSmartProvider !== undefined;
  const resolvedUseSmartProvider = providerChosen ? useSmartProvider : repoDefaults.defaultUseSmartProvider;
  const resolvedAiProviderId = providerChosen ? aiProviderId : repoDefaults.defaultAiProviderId;
  // "After task completes" is one choice spread over three fields, so a caller
  // that sets any of them has made it — the repo's default git mode only
  // applies when all three were left out.
  const gitChosen = pushToMain !== undefined || targetBranch !== undefined || createPR !== undefined;
  const gitFields = !gitChosen && repoDefaults.defaultGitMode
    ? gitFieldsForMode(repoDefaults.defaultGitMode, repoDefaults.defaultTargetBranch)
    : { pushToMain: Boolean(pushToMain), targetBranch: targetBranch || null, createPR: Boolean(createPR) };
  // A repo the caller didn't give a branch is cloned at its saved default branch.
  const resolvedRepos = await resolveRepoBranches(repos as { alias: string; url: string; branch?: string }[]);

  const task = await prisma.task.create({
    data: {
      title: resolvedTitle,
      description,
      context: context ?? null,
      position,
      priority: resolvedPriority,
      effort: normalizeEffort(fromCaller(effort, repoDefaults.defaultEffort)),
      // Per-task tool grants/denials (e.g. {"github-cli": true}). Anything left out
      // follows Settings → Agent Tools at run time — see src/lib/agent-tools.ts.
      toolAccess: serializeToolAccess(toolAccess),
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      cronExpression: isRecurringTemplate ? (cronExpression ?? null) : null,
      // Only meaningful for recurring templates; null == unlimited runs.
      maxRuns: isRecurringTemplate ? normalizeMaxRuns(maxRuns) : null,
      pushToMain: gitFields.pushToMain,
      targetBranch: gitFields.targetBranch,
      createPR: gitFields.createPR,
      isRecurringTemplate,
      isEnabled: Boolean(isEnabled),
      tokenBudget: resolvedTokenBudget ? Number(resolvedTokenBudget) : null,
      costBudget: resolvedCostBudget ? Number(resolvedCostBudget) : null,
      attachments: attachments ? JSON.stringify(attachments) : null,
      attachmentsFolder: attachmentsFolder
        ? String(attachmentsFolder).trim().replace(/^\/+|\/+$/g, "") || null
        : null,
      contextFiles: Array.isArray(contextFiles) && contextFiles.length > 0
        ? JSON.stringify(
            (contextFiles as { repoAlias?: string; path?: string }[])
              .map((f) => ({
                repoAlias: String(f.repoAlias ?? "").trim(),
                path: String(f.path ?? "").trim().replace(/^\/+|\/+$/g, ""),
              }))
              .filter((f) => f.path)
          )
        : null,
      labels: Array.isArray(resolvedLabels) && resolvedLabels.length > 0 ? JSON.stringify(resolvedLabels) : null,
      aiProviderId: (resolvedUseSmartProvider ? null : (resolvedAiProviderId || null)),
      useSmartProvider: Boolean(resolvedUseSmartProvider),
      model: resolvedModel?.trim() || null,
      dependsOnTaskId: dependsOnTaskId || null,
      teamId: resolvedTeamId,
      systemPrompt: systemPrompt?.trim() || null,
      createValidationTask: Boolean(resolvedCreateValidationTask),
      // Lets the agent queue its own subtasks via .subtasks.json — see src/lib/subtasks.ts.
      allowSubtasks: Boolean(resolvedAllowSubtasks),
      outputType: resolvedOutputType,
      repos: {
        create: resolvedRepos.map((r) => ({ alias: r.alias, url: r.url, branch: r.branch })),
      },
    },
    include: { repos: true, team: { select: { id: true, name: true } } },
  });

  return NextResponse.json(task, { status: 201 });
}
