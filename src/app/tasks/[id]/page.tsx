import { notFound } from "next/navigation";
import { displayChangesSummary } from "@/lib/changes-summary";
import Link from "next/link";
import type { Metadata } from "next";
import type React from "react";
import {
  AlertTriangle, Bot, CalendarClock, CheckCircle2, ChevronDown, Clock, ExternalLink, FileText, FolderOpen,
  GitBranch, GitCommitHorizontal, GitPullRequest, Info, MinusCircle, Pencil, PlayCircle, Repeat, ScrollText,
  ListTree, SquareTerminal, Tag, Users, Eye, StickyNote,
} from "lucide-react";
import { CronExpressionParser } from "cron-parser";
import { prisma } from "@/lib/db";
import { getProvider } from "@/lib/smart-provider";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge } from "@/components/PriorityBadge";
import { LogViewer } from "@/components/LogViewer";
import { TeamProgressTracker } from "@/components/TeamProgressTracker";
import { parseTeamProgress } from "@/lib/team-progress";
import { TaskComposer } from "@/components/TaskComposer";
import { canMessageTask } from "@/lib/task-message-mode";
import { LocalDateTime } from "@/components/LocalDateTime";
import { DeleteTaskButton } from "@/components/DeleteTaskButton";
import { RetryTaskButton } from "@/components/RetryTaskButton";
import { ResumeTaskButton } from "@/components/ResumeTaskButton";
import { KillTaskButton } from "@/components/KillTaskButton";
import { ToggleRecurringButton } from "@/components/ToggleRecurringButton";
import { RunBacklogTaskButton } from "@/components/RunBacklogTaskButton";
import { RunNowButton } from "@/components/RunNowButton";
import { EditThrottledButton } from "@/components/EditThrottledButton";
import { DisableTaskButton } from "@/components/DisableTaskButton";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import type { TaskStatus } from "@/lib/types";
import { getDisplayStatus } from "@/lib/types";
import { isFileBasedOutput, isReadOnlyOutput, isResultOutput, getTaskFilesHref } from "@/lib/output-type";
import { formatRunUsage, hasReachedRunLimit } from "@/lib/max-runs";
import { LiveTokenUsage } from "@/components/LiveTokenUsage";
import { TaskExec } from "@/components/TaskExec";
import { CopyButton } from "@/components/CopyButton";
import { MarkdownContent } from "@/components/MarkdownContent";
import { FailureDiagnosis } from "@/components/FailureDiagnosis";
import { CompletionVerifier } from "@/components/CompletionVerifier";
import { FileOutputViewer } from "@/components/FileOutputViewer";
import { TaskActionsDropdown } from "@/components/TaskActionsDropdown";
import { RecurringAdvancedOptions } from "@/components/RecurringAdvancedOptions";
import { BackLink } from "@/components/BackLink";
import { getCheckoutCommand, getCommitUrl, getBranchUrl, getCompareUrl, parseCommitShas, parsePRUrls } from "@/lib/git-urls";
import { TestPlanDisplay } from "@/components/TestPlanDisplay";
import { loadGitProviderSettings } from "@/lib/git-auth";
import { githubCommitUrl, readReviewMetadata } from "@/lib/review-only";
import { fetchReviewPrState } from "@/lib/review-pr-state";
import { ReviewMetadataDetails } from "@/components/ReviewMetadataDetails";
import { ReviewDecisionButtons } from "@/components/ReviewDecisionButtons";

function getNextRunDates(cronExpression: string, lastScheduledAt: Date | null, count = 5): Date[] {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: lastScheduledAt ?? undefined,
    });
    return Array.from({ length: count }, () => interval.next().toDate());
  } catch {
    return [];
  }
}


function relativeTime(date: Date): string {
  const ms = date.getTime() - Date.now();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(ms / 3600000);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const task = await prisma.task.findUnique({ where: { id }, select: { title: true, description: true, status: true } });
  if (!task) return { title: "Task Not Found – AI Task Manager" };
  const rawStatusLabel = task.status.replace(/_/g, " ");
  const statusLabel = rawStatusLabel.charAt(0).toUpperCase() + rawStatusLabel.slice(1);
  return {
    title: `${task.title} [${statusLabel}] – AI Task Manager`,
    description: task.description.slice(0, 160),
  };
}

export default async function TaskDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  const { id } = await params;
  const { from } = await searchParams;
  const backHref = from === "kanban" ? "/tasks/kanban" : "/tasks";
  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      repos: true,
      aiProvider: true,
      team: { include: { members: { orderBy: { position: "asc" }, select: { id: true, name: true, requiresApproval: true } } } },
      dependsOn: { select: { id: true, title: true, status: true } },
      dependents: { select: { id: true, title: true, status: true } },
      parentTask: { select: { id: true, title: true, status: true } },
      subtasks: { select: { id: true, title: true, status: true }, orderBy: { position: "asc" } },
      // Top-level file entries only (a task's output files live inside a single
      // wrapper folder, so this is normally just that one folder).
      files: { where: { parentId: null }, select: { id: true, isFolder: true }, orderBy: { createdAt: "asc" } },
    },
  });

  if (!task) notFound();

  // Review-only ticket (src/lib/review-only.ts): never runs, so there are no logs,
  // cost or agent-written summary — the page shows the ticket and its review metadata.
  const reviewOnly = task.reviewOnly;
  const reviewMeta = readReviewMetadata(task);
  const reviewPrState = reviewOnly ? await fetchReviewPrState(reviewMeta.prUrl) : null;

  type AnyTask = typeof task & {
    aiProvider?: { id: string; name: string; type: string; model: string | null; isEnabled: boolean; throttledUntil?: Date | null } | null;
    team?: { id: string; name: string; members: { id: string; name: string; requiresApproval: boolean }[] } | null;
    dependsOn?: { id: string; title: string; status: string } | null;
    dependents?: Array<{ id: string; title: string; status: string }>;
    attachments?: string | null;
    costBudget?: number | null;
    tokenBudget?: number | null;
    notes?: string | null;
    labels?: string | null;
    systemPrompt?: string | null;
  };
  const typedTask = task as AnyTask;
  const aiProvider = typedTask.aiProvider ?? null;
  const team = typedTask.team ?? null;

  // If no task-specific provider, the worker resolves one at run time — via the per-task
  // useSmartProvider flag or the global smart_provider_picker setting — rather than always
  // using the org's default provider. Only fall back to displaying the default when smart
  // picking isn't in play, so a smart-picked task isn't mislabeled as using "(default)".
  let isSmartPick = false;
  let displayProvider = aiProvider;
  // A pinned provider that has since been *disabled* will not be the one that runs this task —
  // the worker falls through to smart pick → default → any enabled connection. Show what will
  // actually run it, so a switched-off connection doesn't look like it's still in use.
  // Deliberately limited to disabled (not throttled): with `auto_switch_provider` off, a
  // rate-limited provider really is the one the task waits for.
  const willBeSubstituted =
    !!aiProvider &&
    !aiProvider.isEnabled &&
    ["pending", "throttled", "paused", "backlog"].includes(task.status);
  if (willBeSubstituted) {
    const { provider: resolved, source } = await getProvider({
      explicitProviderId: task.aiProviderId,
      useSmartProvider: task.useSmartProvider,
    });
    isSmartPick = source === "smart";
    displayProvider = resolved as typeof displayProvider;
  }
  if (!displayProvider && !willBeSubstituted) {
    // Ask the same resolver the worker uses, so the label names the provider that would
    // actually run this task rather than a default that may be disabled or throttled.
    const { provider: resolved, source } = await getProvider({ useSmartProvider: task.useSmartProvider });
    isSmartPick = source === "smart";
    displayProvider = isSmartPick ? null : resolved;
  }

  const TERMINAL_STATUSES_FOR_DURATION = ["completed", "no_changes", "failed", "killed", "timedout"] as const;
  const isTerminalTask = TERMINAL_STATUSES_FOR_DURATION.includes(task.status as typeof TERMINAL_STATUSES_FOR_DURATION[number]);
  const isRunning = task.status === "running";
  // Recurring templates can be capped to a maximum number of scheduled runs (maxRuns);
  // once the cap is hit the worker stops spawning instances, so suppress "next runs" here.
  const runLimitReached = task.isRecurringTemplate && hasReachedRunLimit(task);

  const [instances, recurringTemplate, taskDuration, taskStartedAt, lastAiMessage, gitProviderSettings, logCount] = await Promise.all([
    task.isRecurringTemplate
      ? prisma.task.findMany({ where: { recurringTemplateId: id }, orderBy: { createdAt: "desc" } })
      : Promise.resolve([]),
    task.recurringTemplateId
      ? prisma.task.findUnique({ where: { id: task.recurringTemplateId }, select: { id: true, title: true } })
      : Promise.resolve(null),
    isTerminalTask
      ? (async () => {
          // Find the "Starting task" log and the last log to compute duration
          const [startLog, endLog] = await Promise.all([
            prisma.taskLog.findFirst({
              where: { taskId: id, level: "system", content: { startsWith: "Starting task:" } },
              orderBy: { createdAt: "asc" },
              select: { createdAt: true },
            }),
            prisma.taskLog.findFirst({
              where: { taskId: id },
              orderBy: { createdAt: "desc" },
              select: { createdAt: true },
            }),
          ]);
          if (!startLog || !endLog) return null;
          return new Date(endLog.createdAt).getTime() - new Date(startLog.createdAt).getTime();
        })()
      : Promise.resolve(null),
    // For running tasks: grab the start log timestamp so the client can show a live elapsed timer
    (isRunning || isTerminalTask)
      ? prisma.taskLog.findFirst({
          where: { taskId: id, level: "system", content: { startsWith: "Starting task:" } },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }).then((l: { createdAt: Date } | null) => (l ? new Date(l.createdAt).toISOString() : null))
      : Promise.resolve(null),
    // For completed/failed tasks: grab the last AI info log as a result summary
    isTerminalTask
      ? prisma.taskLog.findFirst({
          where: { taskId: id, level: "info" },
          orderBy: { createdAt: "desc" },
          select: { content: true, createdAt: true },
        })
      : Promise.resolve(null),
    // "Push directly to main" actually pushes to whatever Settings > Git's default base
    // branch is configured as (see worker/index.ts), which isn't necessarily literally
    // "main" — fetch it so the display below names the real target branch.
    loadGitProviderSettings(),
    // Whether this task has any history — a follow-up re-queues a finished task to
    // "pending", and its earlier conversation should stay visible while it waits.
    task.isRecurringTemplate ? Promise.resolve(0) : prisma.taskLog.count({ where: { taskId: id } }),
  ]);
  const gitDefaultBaseBranch = gitProviderSettings.defaultBaseBranch;

  // Accordion open-state logic:
  // - Completed tasks with a result → open the Result accordion, close Logs
  // - Running tasks → open Logs (live feed is most useful)
  // - Paused/throttled → open Logs (show what happened before the rate limit hit)
  // - Failed/killed/timedout → open Logs (diagnose what went wrong)
  // - Pending tasks → open the prompt (nothing else to look at yet), or Logs when
  //   a follow-up has re-queued a task that already has history
  const isResultOpen = !task.isRecurringTemplate && (task.status === "completed" || task.status === "no_changes") && lastAiMessage !== null;
  const hasLogs = logCount > 0;
  const isLogsOpen = !task.isRecurringTemplate && (
    task.status === "running" ||
    task.status === "paused" ||
    task.status === "throttled" ||
    task.status === "awaiting_approval" ||
    (task.status === "pending" && hasLogs) ||
    (isTerminalTask && task.status !== "completed" && task.status !== "no_changes")
  );
  const showLogs = !reviewOnly && !task.isRecurringTemplate && (task.status !== "pending" || hasLogs);
  const isPromptOpen = !isResultOpen && !isLogsOpen;
  const showComposer = !reviewOnly && !task.isRecurringTemplate && canMessageTask(task.status);
  const showTerminal = !reviewOnly && !task.isRecurringTemplate && (isTerminalTask || isRunning);

  // Multi-repo tasks create one PR per repo (see worker/index.ts); task.prUrl/prNumber only
  // ever mirror the first one, so use the full per-repo map for display so every repo's PR
  // (and merged state) shows up here instead of just the first repo's.
  const prUrlsMap = parsePRUrls(task.prUrls);
  const prUrlEntries = Object.entries(prUrlsMap);
  // Per-repo commit SHAs from the worker's direct-push commit (see worker/index.ts). Used to
  // link straight to the commit when a task pushed directly to a branch without opening a PR.
  // The worker's "Changes summary" used to be headed "PR: <title>" even for tasks that only
  // pushed to a branch — reword it as a branch push when no PR exists.
  const changesSummary = displayChangesSummary(task.prSummary, prUrlEntries.length > 0 || !!task.prUrl);
  const commitShaMap = parseCommitShas((task as { commitSha?: string | null }).commitSha);
  const directCommitEntries = prUrlEntries.length === 0 && !task.prUrl
    ? task.repos
        .map((r: { alias: string; url: string }) => {
          const sha = commitShaMap[r.alias];
          const href = sha ? getCommitUrl(r.url, sha) : null;
          return href ? { alias: r.alias, href } : null;
        })
        .filter((e: { alias: string; href: string } | null): e is { alias: string; href: string } => e !== null)
    : [];

  let labelList: string[] = [];
  if (typedTask.labels) {
    try { labelList = JSON.parse(typedTask.labels) as string[]; } catch { /* ignore */ }
  }
  let attachments: Array<{ id: string; name: string; mimeType: string }> = [];
  if (typedTask.attachments) {
    try { attachments = JSON.parse(typedTask.attachments) as typeof attachments; } catch { /* ignore malformed JSON */ }
  }

  const nextRuns = task.isRecurringTemplate && task.cronExpression && !runLimitReached
    ? getNextRunDates(task.cronExpression, task.lastScheduledAt ? new Date(task.lastScheduledAt) : null)
    : [];
  const isScheduledInFuture = !!task.scheduledFor && task.status === "pending" && new Date(task.scheduledFor) > new Date();
  const providerLabel = displayProvider?.name ?? (isSmartPick ? "Smart pick" : task.provider);
  const modelLabel = task.model ?? displayProvider?.model ?? null;

  return (
    <div className="max-w-7xl mx-auto">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="mb-6">
        <BackLink href={backHref} label="← Tasks" />
        <div className="flex items-start gap-3">
          {task.isRecurringTemplate && <Repeat className="size-5 text-sky-400 mt-1.5 shrink-0" />}
          <h1 className="text-2xl font-bold leading-tight min-w-0 flex-1 break-words">{task.title}</h1>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
          {!task.isRecurringTemplate && (
            <span className="flex items-center gap-1.5">
              {reviewOnly ? (
                <span
                  title="Review-only ticket: a reminder to review work done elsewhere. It never runs an agent."
                  className="inline-flex items-center gap-1 text-xs bg-sky-500/10 text-sky-400 px-1.5 py-0.5 rounded-full border border-sky-500/20"
                >
                  <Eye className="size-3" />
                  Review only · {task.reviewStatus === "done" ? "Done" : "In Review"}
                </span>
              ) : (
                <StatusBadge status={getDisplayStatus({ status: task.status, isEnabled: task.isEnabled ?? true }) as TaskStatus} />
              )}
              <PriorityBadge priority={typedTask.priority} />
              {typedTask.hasConflict && (
                <span
                  title={typedTask.conflictMessage || "Merge conflict detected while syncing this branch"}
                  className="inline-flex items-center gap-1 text-xs bg-destructive/10 text-destructive px-1.5 py-0.5 rounded-full border border-destructive/20"
                >
                  <AlertTriangle className="size-3" />
                  Conflict
                </span>
              )}
              {typedTask.noChanges && (
                <span
                  title="This PR merged with no code changes, so it wasn't auto-moved to Done."
                  className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full border border-border"
                >
                  <MinusCircle className="size-3" />
                  No changes
                </span>
              )}
            </span>
          )}
          {task.isRecurringTemplate && task.cronExpression && (
            <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{task.cronExpression}</span>
          )}
          {!reviewOnly && (
            <span className="inline-flex items-center gap-1">
              <Bot className="size-3.5" />
              <span className="text-foreground/90">{team ? team.name : providerLabel}</span>
              {!team && modelLabel && <span>· {modelLabel}</span>}
            </span>
          )}
          {taskDuration !== null && taskDuration !== undefined && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" />
              {formatDuration(taskDuration)}
            </span>
          )}
          {recurringTemplate && (
            <span className="inline-flex items-center gap-1">
              <Repeat className="size-3.5" />
              <Link href={`/tasks/${recurringTemplate.id}`} className="text-sky-400 hover:underline">
                {recurringTemplate.title}
              </Link>
            </span>
          )}
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-border">
          {task.isRecurringTemplate && (
            <ToggleRecurringButton taskId={task.id} isEnabled={task.isEnabled ?? true} />
          )}
          {task.isRecurringTemplate && (
            <RunNowButton taskId={task.id} mode="recurring" />
          )}
          {!task.isRecurringTemplate && !task.isEnabled && task.status === "pending" && (
            <RunBacklogTaskButton taskId={task.id} />
          )}
          {!task.isRecurringTemplate && task.isEnabled && task.status === "pending" && (
            <DisableTaskButton taskId={task.id} />
          )}
          {!task.isRecurringTemplate && task.isEnabled && isScheduledInFuture && (
            <RunNowButton taskId={task.id} mode="scheduled" />
          )}
          {!task.isRecurringTemplate && task.isEnabled && (task.status === "running" || task.status === "pending" || task.status === "paused" || task.status === "awaiting_approval") && (
            <KillTaskButton taskId={task.id} />
          )}
          {!task.isRecurringTemplate && task.status === "throttled" && <ResumeTaskButton taskId={task.id} />}
          {reviewOnly && <ReviewDecisionButtons taskId={task.id} reviewStatus={task.reviewStatus} />}
          {reviewOnly && reviewMeta.prUrl && (
            <a href={reviewMeta.prUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <GitPullRequest className="size-4 mr-1.5" />View PR{reviewPrState?.state === "merged" ? " ✓" : ""}
            </a>
          )}
          {reviewOnly && !reviewMeta.prUrl && reviewMeta.commits.length === 1 && githubCommitUrl(reviewMeta, reviewMeta.commits[0]) && (
            <a href={githubCommitUrl(reviewMeta, reviewMeta.commits[0])!} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <ExternalLink className="size-4 mr-1.5" />View Commit
            </a>
          )}
          {!reviewOnly && !task.isRecurringTemplate && isTerminalTask && (
            <div className="relative">
              <RetryTaskButton
                taskId={task.id}
                currentProviderId={task.aiProviderId}
                description={task.description}
                context={task.context ?? null}
              />
            </div>
          )}
          {(task.isRecurringTemplate || task.status === "pending" || reviewOnly) && (
            <Link href={`/tasks/${task.id}/edit`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              <Pencil className="size-4 mr-1.5" />Edit
            </Link>
          )}
          {!task.isRecurringTemplate && task.status === "throttled" && (
            <EditThrottledButton taskId={task.id} />
          )}
          {prUrlEntries.map(([alias, pr]) => (
            <a key={alias} href={pr.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <GitPullRequest className="size-4 mr-1.5" />View PR{prUrlEntries.length > 1 ? ` (${alias})` : ""}{pr.merged ? " ✓" : ""}
            </a>
          ))}
          {prUrlEntries.length === 0 && task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <GitPullRequest className="size-4 mr-1.5" />View PR
            </a>
          )}
          {/* Direct-push tasks (no PR) still produce a commit — offer the same kind of
              quick-jump button "View PR" gives, pointed at the commit instead. */}
          {directCommitEntries.map((e: { alias: string; href: string }) => (
            <a key={e.alias} href={e.href} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <ExternalLink className="size-4 mr-1.5" />View Commit{directCommitEntries.length > 1 ? ` (${e.alias})` : ""}
            </a>
          ))}
          {!task.isRecurringTemplate && isFileBasedOutput(task.outputType) && task.status === "completed" && (
            <Link
              href={getTaskFilesHref(task.files)}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              <FolderOpen className="size-4 mr-1.5" />View files
            </Link>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* Actions dropdown: Verify Completion + Export (terminal tasks only), plus
                secondary navigation actions (Duplicate, Browse workspace) that don't need
                to live in the primary button row. */}
            <TaskActionsDropdown
              taskId={task.id}
              taskStatus={task.status}
              isTerminalTask={isTerminalTask && !reviewOnly}
              isRecurringTemplate={task.isRecurringTemplate}
              outputType={task.outputType}
              title={task.title}
              description={task.description}
              context={task.context ?? null}
              notes={typedTask.notes ?? null}
              labels={typedTask.labels ?? null}
              prSummary={changesSummary}
              prUrl={task.prUrl ?? null}
              branchName={task.branchName ?? null}
              createdAt={new Date(task.createdAt).toISOString()}
              inputTokens={task.inputTokens ?? null}
              outputTokens={task.outputTokens ?? null}
              estimatedCost={task.estimatedCost ?? null}
              providerName={displayProvider?.name ?? task.provider ?? null}
              model={modelLabel}
              repos={task.repos.map((r: { alias: string; url: string }) => ({ alias: r.alias, url: r.url }))}
              lastAiMessage={lastAiMessage ?? null}
            />
            <DeleteTaskButton taskId={task.id} />
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
        {/* ── Main column: the conversation with the agent ─────────────────── */}
        <main className="flex flex-col gap-4 min-w-0">
          {isScheduledInFuture && (
            <Banner tone="info" icon={<CalendarClock className="size-4" />}>
              Scheduled for {new Date(task.scheduledFor!).toLocaleString(undefined, { timeZoneName: "short" })}
              {" "}({relativeTime(new Date(task.scheduledFor!))})
            </Banner>
          )}
          {typedTask.hasConflict && (
            <Banner tone="danger" icon={<AlertTriangle className="size-4" />}>
              Merge conflict detected{typedTask.conflictMessage ? `: ${typedTask.conflictMessage}` : " while syncing this branch"}
            </Banner>
          )}
          {!task.prUrl && task.prError && (
            <Banner tone="warning" icon={<AlertTriangle className="size-4" />}>
              PR creation failed: {task.prError}
            </Banner>
          )}
          {task.status === "no_changes" && (
            <Banner tone="muted" icon={<CheckCircle2 className="size-4" />}>
              No code changes were made, nothing to commit or open a PR for.
            </Banner>
          )}

          {/* AI-powered failure analysis — shown for failed tasks */}
          {!task.isRecurringTemplate && task.status === "failed" && (
            <FailureDiagnosis taskId={task.id} />
          )}

          {/* The prompt the agent was given */}
          <Section title={task.isRecurringTemplate ? "Prompt template" : reviewOnly ? "Description" : "Prompt"} icon={<FileText className="size-4" />} defaultOpen={isPromptOpen || reviewOnly}>
            <p className="text-card-foreground whitespace-pre-wrap break-words text-sm leading-relaxed">{task.description}</p>
            {task.context && (
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-medium">Context</p>
                <p className="text-muted-foreground whitespace-pre-wrap break-words text-sm">{task.context}</p>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wide font-medium">Attachments</p>
                <div className="flex flex-wrap gap-3">
                  {attachments.map((att) => (
                    <div key={att.id} className="flex flex-col items-center gap-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/attachments/${att.id}.${att.name.split(".").pop()}`}
                        alt={att.name}
                        className="w-24 h-24 object-cover rounded-lg border border-border"
                      />
                      <span className="text-xs text-muted-foreground truncate max-w-24">{att.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {typedTask.systemPrompt && (
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-medium">Custom System Prompt</p>
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded-md px-3 py-2 max-h-40 overflow-y-auto">{typedTask.systemPrompt}</pre>
              </div>
            )}
          </Section>

          {reviewOnly && typedTask.notes && (
            <Section title="Notes" icon={<StickyNote className="size-4" />} defaultOpen>
              <p className="text-muted-foreground whitespace-pre-wrap break-words text-sm">{typedTask.notes}</p>
            </Section>
          )}

          {/* Result — open by default for completed tasks */}
          {!reviewOnly && !task.isRecurringTemplate && isTerminalTask && lastAiMessage && (
            <FileOutputViewer
              taskId={task.id}
              content={lastAiMessage.content}
              contentTimestamp={new Date(lastAiMessage.createdAt).toISOString()}
              branchName={task.branchName ?? null}
              defaultOpen={isResultOpen}
            />
          )}

          {/* Completion verification result — triggered from the Actions dropdown */}
          {!reviewOnly && !task.isRecurringTemplate && task.status === "completed" && (
            <CompletionVerifier taskId={task.id} />
          )}

          {changesSummary && (
            <Section
              title="Changes summary"
              icon={<GitCommitHorizontal className="size-4" />}
              defaultOpen={isResultOpen}
              action={<CopyButton text={changesSummary} label="Copy changes summary to clipboard" />}
            >
              <MarkdownContent content={changesSummary} />
            </Section>
          )}

          {task.testPlan && <TestPlanDisplay testPlan={task.testPlan} />}

          {team && !task.isRecurringTemplate && (
            <Section title="Team progress" icon={<Users className="size-4" />} defaultOpen>
              <TeamProgressTracker
                taskId={task.id}
                initialStatus={task.status}
                initialProgress={parseTeamProgress(task.teamProgress)}
                initialRoster={team.members}
                model={modelLabel}
                providerType={displayProvider?.type ?? task.provider ?? null}
              />
            </Section>
          )}

          {showLogs && (
            <Section title="Activity" icon={<ScrollText className="size-4" />} defaultOpen={isLogsOpen}>
              <LogViewer taskId={task.id} initialStatus={task.status} />
            </Section>
          )}

          {/* Prompt composer — lives outside the logs so it's always reachable, and
              sticks to the bottom of the viewport while scrolling the conversation. */}
          {showComposer && (
            <div className="sticky bottom-4 z-20">
              <TaskComposer taskId={task.id} status={task.status} />
            </div>
          )}

          {showTerminal && (
            <Section title="Terminal" icon={<SquareTerminal className="size-4" />}>
              <TaskExec taskId={task.id} repos={task.repos.map((r: { alias: string }) => ({ alias: r.alias }))} />
            </Section>
          )}

          {task.isRecurringTemplate && (
            <Card>
              <CardContent className="pt-4">
                <h2 className="text-base font-semibold mb-3">Advanced Options</h2>
                <RecurringAdvancedOptions taskId={task.id} isHailMary={task.isHailMary ?? false} />
              </CardContent>
            </Card>
          )}

          {task.isRecurringTemplate && instances.length > 0 && (
            <Section title={`Instances (${instances.length})`} icon={<Repeat className="size-4" />} defaultOpen>
              <div className="flex flex-col gap-1 -mx-3">
                {instances.map((inst: { id: string; createdAt: Date; status: string }) => (
                  <Link key={inst.id} href={`/tasks/${inst.id}`} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted text-sm transition-colors">
                    <span className="text-muted-foreground">{new Date(inst.createdAt).toLocaleString()}</span>
                    <StatusBadge status={inst.status as TaskStatus} />
                  </Link>
                ))}
              </div>
            </Section>
          )}

          {task.isRecurringTemplate && instances.length === 0 && (
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-muted-foreground">No instances yet. The worker will spawn one when the cron schedule fires.</p>
              </CardContent>
            </Card>
          )}
        </main>

        {/* ── Sidebar: metadata ───────────────────────────────────────────── */}
        <aside className="flex flex-col gap-4 min-w-0">
          {reviewOnly && (
            <SidebarCard title="To review" icon={<Eye className="size-4" />}>
              <ReviewMetadataDetails meta={reviewMeta} prState={reviewPrState} />
            </SidebarCard>
          )}

          {/* Token usage + retry/resume info */}
          {!reviewOnly && !task.isRecurringTemplate && (
            task.inputTokens != null ||
            task.outputTokens != null ||
            task.status === "running" ||
            task.retryCount > 0 ||
            task.reviewIterationCount > 0 ||
            (task.status === "throttled" && task.nextRetryAt)
          ) && (
            <LiveTokenUsage
              taskId={task.id}
              inputTokens={task.inputTokens ?? null}
              outputTokens={task.outputTokens ?? null}
              estimatedCost={task.estimatedCost ?? null}
              status={task.status}
              provider={task.provider}
              model={task.model ?? null}
              costBudget={typedTask.costBudget ?? null}
              tokenBudget={typedTask.tokenBudget ?? null}
              startedAt={taskStartedAt}
              retryCount={task.retryCount}
              reviewIterationCount={task.reviewIterationCount}
              nextRetryAt={task.nextRetryAt ? new Date(task.nextRetryAt).toISOString() : null}
            />
          )}

          {task.isRecurringTemplate && (
            <SidebarCard title="Schedule" icon={<CalendarClock className="size-4" />}>
              {task.cronExpression && (
                <DetailRow label="Cron"><code className="text-xs bg-muted px-1.5 py-0.5 rounded">{task.cronExpression}</code></DetailRow>
              )}
              <DetailRow label="Runs">
                {formatRunUsage(task)}
                {task.maxRuns == null && <span className="text-muted-foreground"> (unlimited)</span>}
              </DetailRow>
              {runLimitReached && (
                <p className="text-xs text-amber-400">Limit reached, no further runs will be scheduled.</p>
              )}
              {nextRuns.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Next runs</p>
                  <ul className="flex flex-col gap-0.5">
                    {nextRuns.map((d, i) => (
                      <li key={i} className="text-xs text-sky-400 tabular-nums">
                        {d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </SidebarCard>
          )}

          <SidebarCard title="Details" icon={<Info className="size-4" />}>
            {!reviewOnly && <DetailRow label="Provider">
              {providerLabel}
              {displayProvider && !aiProvider && <span className="text-muted-foreground"> (default)</span>}
              {!displayProvider && isSmartPick && <span className="text-muted-foreground"> (resolved at run time)</span>}
              {willBeSubstituted && (
                <span className="block text-xs text-muted-foreground">
                  replacing &ldquo;{aiProvider?.name}&rdquo;, which is disabled
                </span>
              )}
            </DetailRow>}
            {!reviewOnly && modelLabel && <DetailRow label="Model"><span className="font-mono text-xs">{modelLabel}</span></DetailRow>}
            {!reviewOnly && task.outputType && task.outputType !== "repository" && (
              <DetailRow label="Output">
                {isResultOutput(task.outputType) ? "Result only" : task.outputType === "design" ? "Design" : "File(s)"}
              </DetailRow>
            )}
            {team && (
              <DetailRow label="Team">
                <Link href="/teams" className="hover:underline">{team.name}</Link>
                <span className="block text-xs text-muted-foreground">
                  {team.members.map((m: { name: string }) => m.name).join(" → ") || "no members"}
                </span>
              </DetailRow>
            )}
            {taskDuration !== null && taskDuration !== undefined && (
              <DetailRow label="Duration">{formatDuration(taskDuration)}</DetailRow>
            )}
            <DetailRow label="Created"><LocalDateTime iso={new Date(task.createdAt).toISOString()} /></DetailRow>
            {typedTask.costBudget != null && (
              <DetailRow label="Cost budget"><span className="font-mono">${typedTask.costBudget.toFixed(2)}</span></DetailRow>
            )}
            {labelList.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {labelList.map((label) => (
                  <span key={label} className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary/80 px-2 py-0.5 rounded-full border border-primary/20">
                    <Tag className="size-3 shrink-0" />
                    {label}
                  </span>
                ))}
              </div>
            )}
          </SidebarCard>

          {task.repos.length > 0 && (
            <SidebarCard title={task.repos.length > 1 ? "Repositories" : "Repository"} icon={<GitBranch className="size-4" />}>
              <ul className="flex flex-col gap-2">
                {task.repos.map((r: { id: string; alias: string; url: string; branch?: string | null }) => (
                  <li key={r.id} className="text-sm min-w-0">
                    <span className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">{r.alias}</span>
                    <span className="block text-xs text-muted-foreground break-all mt-1">{r.url}</span>
                    {r.branch && (
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        base: <code className="bg-muted px-1 rounded">{r.branch}</code>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {task.repos.some((r: { url: string }) => r.url) && (
                <DetailRow label="On finish">
                  {isReadOnlyOutput(task.outputType)
                    ? isResultOutput(task.outputType)
                      ? "Read-only context, result shown above"
                      : "Read-only context, no commits"
                    : task.pushToMain
                    ? <>Push to <code className="text-xs bg-muted px-1 rounded">{gitDefaultBaseBranch}</code></>
                    : task.createPR
                    ? "Open a PR"
                    : task.targetBranch
                    ? <>Push to <code className="text-xs bg-muted px-1 rounded">{task.targetBranch}</code></>
                    : "Push to agent branch"}
                </DetailRow>
              )}
              {task.repos.some((r: { alias: string }) => commitShaMap[r.alias]) && (
                <DetailRow label={task.repos.filter((r: { alias: string }) => commitShaMap[r.alias]).length > 1 ? "Commits" : "Commit"}>
                  <span className="flex flex-col gap-0.5">
                    {task.repos.map((r: { id: string; alias: string; url: string }) => {
                      const sha = commitShaMap[r.alias];
                      if (!sha) return null;
                      const commitHref = getCommitUrl(r.url, sha);
                      const shortSha = sha.slice(0, 7);
                      return (
                        <span key={r.id} className="flex items-center gap-1 min-w-0">
                          <GitCommitHorizontal className="size-3.5 text-muted-foreground shrink-0" />
                          {commitHref ? (
                            <a href={commitHref} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-blue-400 hover:underline" title={sha}>
                              {shortSha}
                            </a>
                          ) : (
                            <code className="font-mono text-xs bg-muted px-1 rounded" title={sha}>{shortSha}</code>
                          )}
                          {task.repos.length > 1 && (
                            <span className="text-xs text-muted-foreground truncate">({r.alias})</span>
                          )}
                          <CopyButton text={sha} label="Copy commit ID" successMessage="Copied commit ID" />
                        </span>
                      );
                    })}
                  </span>
                </DetailRow>
              )}
              {task.branchName && (
                <div className="flex flex-col gap-1.5 pt-2 border-t border-border">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <GitBranch className="size-3.5 text-muted-foreground shrink-0" />
                    <code className="bg-muted px-1.5 py-0.5 rounded text-xs truncate min-w-0" title={task.branchName}>{task.branchName}</code>
                    <CopyButton text={getCheckoutCommand(task.branchName)} label="Copy checkout command" successMessage="Copied checkout command" />
                  </div>
                  {task.repos.map((r: { id: string; alias: string; url: string }) => {
                    const branchHref = getBranchUrl(r.url, task.branchName!);
                    const compareHref = getCompareUrl(r.url, task.branchName!);
                    if (!branchHref && !compareHref) return null;
                    const suffix = task.repos.length > 1 ? ` (${r.alias})` : "";
                    return (
                      <div key={r.id} className="flex flex-wrap gap-x-3 gap-y-1 items-center">
                        {!prUrlsMap[r.alias] && !task.prUrl && branchHref && (
                          <a href={branchHref} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">
                            View branch{suffix}
                          </a>
                        )}
                        {compareHref && (
                          <a href={compareHref} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">
                            View diff{suffix}
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </SidebarCard>
          )}

          {(typedTask.dependsOn || (typedTask.dependents?.length ?? 0) > 0) && (
            <SidebarCard title="Dependencies" icon={<PlayCircle className="size-4" />}>
              {typedTask.dependsOn && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Waits for</p>
                  <Link href={`/tasks/${typedTask.dependsOn.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline">
                    <span className="truncate">{typedTask.dependsOn.title}</span>
                    <span className={`text-xs capitalize shrink-0 ${typedTask.dependsOn.status === "completed" ? "text-green-400" : "text-yellow-400"}`}>
                      {typedTask.dependsOn.status}
                    </span>
                  </Link>
                </div>
              )}
              {(typedTask.dependents?.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Triggers on completion</p>
                  <ul className="flex flex-col gap-1">
                    {typedTask.dependents!.map((d: { id: string; title: string; status: string }) => (
                      <li key={d.id}>
                        <Link href={`/tasks/${d.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline">
                          <span className="truncate">{d.title}</span>
                          <span className="text-xs capitalize text-muted-foreground shrink-0">{d.status}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </SidebarCard>
          )}

          {(task.parentTask || task.allowSubtasks || task.subtasks.length > 0) && (
            <SidebarCard title="Subtasks" icon={<ListTree className="size-4" />}>
              {task.parentTask && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Created by</p>
                  <Link href={`/tasks/${task.parentTask.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline">
                    <span className="truncate">{task.parentTask.title}</span>
                    <span className="text-xs capitalize text-muted-foreground shrink-0">{task.parentTask.status}</span>
                  </Link>
                </div>
              )}
              {task.subtasks.length > 0 ? (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Created {task.subtasks.length} subtask{task.subtasks.length === 1 ? "" : "s"}</p>
                  <ul className="flex flex-col gap-1">
                    {task.subtasks.map((st: { id: string; title: string; status: string }) => (
                      <li key={st.id}>
                        <Link href={`/tasks/${st.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline">
                          <span className="truncate">{st.title}</span>
                          <span className={`text-xs capitalize shrink-0 ${st.status === "completed" ? "text-green-400" : "text-muted-foreground"}`}>{st.status}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : task.allowSubtasks && (
                <p className="text-xs text-muted-foreground">
                  The agent may create subtasks. They&apos;ll be listed here once this task finishes.
                </p>
              )}
            </SidebarCard>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Collapsible card used for the main-column sections. */
function Section({
  title,
  icon,
  defaultOpen = false,
  action,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group rounded-xl border border-border bg-card text-card-foreground shadow-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-5 py-3.5 text-sm font-semibold select-none list-none [&::-webkit-details-marker]:hidden">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        {title}
        <span className="ml-auto flex items-center gap-2">
          {action}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}

function SidebarCard({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card text-card-foreground shadow-sm">
      <h2 className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </h2>
      <div className="px-4 pb-4 flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

const BANNER_TONES = {
  info: "border-sky-500/30 bg-sky-500/5 text-sky-400",
  warning: "border-amber-500/30 bg-amber-500/5 text-amber-500",
  danger: "border-destructive/30 bg-destructive/5 text-destructive",
  muted: "border-border bg-muted/40 text-muted-foreground",
} as const;

function Banner({ tone, icon, children }: { tone: keyof typeof BANNER_TONES; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${BANNER_TONES[tone]}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
