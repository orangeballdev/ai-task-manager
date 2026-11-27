// Must stay first: patches `http` before any HTTP client loads (see the module).
import "../lib/otel-preload";
import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import path from "path";
import fs from "fs";
import { ensureSqliteWalMode } from "../lib/sqlite-pragmas";
import { spawn } from "child_process";
import { CronExpressionParser } from "cron-parser";
import { createProvider } from "../lib/providers/index";
import type { Provider, ExecutionResult, MessageFetcher, CancelChecker, TokenUpdateCallback } from "../lib/providers/index";
import { cloneRepo, createAndCheckoutBranch, branchName, commitAll, pushBranch, generatePRSummary, safeEnv, openRepo, pullAndSyncWorkingRepo, rebaseOntoBase, syncWithBaseBranch, resolveRepoHadChanges, EMPTY_REPO_BASELINE, countCommitsAheadOfBase, resolveBaseBranch, verifyBranchPushed } from "../lib/git";
import { loadGitCredentials, loadGitProviderSettings } from "../lib/git-auth";
import { detectProvider, createGitHubPR, createGitLabMR, createGitHubPRComment, createGitLabMRComment, findOpenGitHubPR, findOpenGitLabMR } from "../lib/pr-creator";
import { syncTaskPRStatuses } from "../lib/pr-sync";
import { parsePRUrls } from "../lib/git-urls";
import { decidePrAction } from "../lib/pr-decision";
import { REVIEW_PR_MARKER } from "../lib/review-pr";
import { buildPrompt, extractTestPlan } from "../lib/prompt-builder";
import { isFileBasedOutput, isReadOnlyOutput } from "../lib/output-type";
import { getRepoDest, getWorkspacePath, ensureWorkspace } from "../lib/workspace";
import { runCleanup } from "../lib/cleanup";
import { calculateCost, estimateCostForCli, findPricing } from "../lib/token-cost";
import { recordProviderAuthFailure } from "../lib/provider-auth-otel";
import { getNotificationSettings, sendTaskNotification, sendProviderAuthFailureNotification, sendEmailTaskResultReply, getAppHost } from "../lib/notifications";
import { extractOAuthAccessToken, fetchOAuthUsage, extractExpiresAt, isUsageExhausted, describeUsageExhaustion, detectUsageLimit, usageResetTime, readCliExtraUsage, creditGateMayBeStale, isOverUsageCap } from "../lib/health-check";
import { revalidateProviderThrottle } from "../lib/provider-throttle";
import { enforceUsageCap, describeUsageCapHit } from "../lib/usage-cap";
import { comparePriorityThenPosition } from "../lib/priority";
import { normalizeEffort } from "../lib/effort";
import { hasReachedRunLimit } from "../lib/max-runs";
import { getSavedRepos } from "../lib/repos";
import {
  buildRepoConcurrencyLimits,
  countTasksPerRepo,
  repoLimitWaitMessage,
  selectTasksWithinRepoLimits,
  type ConcurrencyTask,
} from "../lib/repo-concurrency";
import { shouldResumeTask } from "../lib/resume";
import { readVerifications } from "../lib/verification-state";
import type { ProviderHealthStatus, HealthCheckCache } from "../lib/health-check";
import { runHailMaryDetector } from "../lib/hail-mary";
import { DEFAULT_ASSISTANT_MODEL, DEFAULT_CODEX_MODEL } from "../lib/models";
import { codexAuthFile, findCodexBinary, resolveCodexHome, extractCodexExpiresAt, CODEX_NOT_FOUND_MESSAGE } from "../lib/providers/codex-exec";
import { syncCredentialsToDisk, canAdoptDiskCredentials } from "../lib/providers/cli-credentials";
import { getProvider, findAlternateProvider, findSoonestThrottledProvider, providerUnavailableMessage } from "../lib/smart-provider";
import { isRestartPending, restartForRestore } from "../lib/restart-signal";
// Pure vendor/model helper — lives next to the Slack proposal code that first needed it,
// but the "don't send a gpt-* id to an Anthropic connection" rule is not Slack-specific.
import { modelFitsProvider } from "../lib/slack-provider";
import { prepareAgentTools, type PreparedAgentTools } from "../lib/agent-tools-runtime";
import { prepareMcpServers, type PreparedMcpServers } from "../lib/mcp-servers-runtime";
import { initTelemetry } from "../lib/otel";
import { registerDbSizeGauges, withDbTelemetry } from "../lib/db-telemetry";
import { agentRunErrorType } from "../lib/gen-ai-telemetry";
import { emitTaskLog, genAiProviderName, registerWorkerGauges, traceTaskRun, markSpanFailed, withAgentSpan, withTaskSpan, type AgentSpanInfo } from "./telemetry";
import { AWAITING_APPROVAL_STATUS, MAX_STAGE_OUTPUT_CHARS, markStageAwaitingApproval, markStageCompleted, markStageEnded, markStageRunning, memberLogPrefix, parseTeamProgress, planTeamResume, serializeTeamProgress, stageNeedsApproval, startTeamProgress, type TeamProgress } from "../lib/team-progress";
import { SUBTASKS_FILE, SUBTASKS_PROCESSED_FILE, buildSubtaskContext, buildSubtasksPromptSection, parseSubtaskRequests } from "../lib/subtasks";
import { copyAttachmentsToWorkspace } from "../lib/attachments";
import { runnableTaskWhere } from "../lib/review-only";

function resolveDbPath(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./data/dev.db";
  const filePath = rawUrl.startsWith("file:") ? rawUrl.slice(5) : rawUrl;
  return path.resolve(filePath);
}

function createPrisma() {
  const resolvedPath = resolveDbPath();
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ensureSqliteWalMode(resolvedPath);
  const adapter = new PrismaBetterSqlite3({ url: resolvedPath });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withDbTelemetry(new (PrismaClient as any)({ adapter }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma: any = createPrisma();

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeTaskStateFile(
  taskId: string,
  taskTitle: string,
  repos: Array<{ alias: string }>,
  stopReason: string,
): Promise<void> {
  try {
    const { execSync } = await import("child_process");
    const workspacePath = getWorkspacePath(taskId);
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }

    const lines: string[] = [];
    lines.push(`# Task State\n`);
    lines.push(`Task: ${taskTitle}`);
    lines.push(`Interrupted at: ${new Date().toISOString()}`);
    lines.push(`Reason: ${stopReason}\n`);

    // Fetch the most recent entries (desc + take), then reverse back to
    // chronological order for display. Ordering `asc` here would instead grab
    // the *oldest* 60 entries, which for a long-running task means the state
    // file captures stale early-run output instead of what the agent had just
    // done right before it was interrupted — the context that actually matters
    // for a clean resume on the next (possibly different) provider.
    const recentLogs = await prisma.taskLog.findMany({
      where: { taskId, level: { in: ["info", "error"] } },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    recentLogs.reverse();

    if (recentLogs.length > 0) {
      lines.push(`## Recent output (last ${recentLogs.length} entries)\n`);
      lines.push("```");
      for (const entry of recentLogs) {
        const prefix = entry.level === "error" ? "[ERROR] " : "";
        lines.push(prefix + entry.content.trim());
      }
      lines.push("```\n");
    }

    for (const repo of repos) {
      const repoDest = getRepoDest(taskId, repo.alias);
      if (fs.existsSync(repoDest)) {
        try {
          const gitLog = execSync("git log --oneline -20", { cwd: repoDest }).toString().trim();
          if (gitLog) {
            lines.push(`## ${repo.alias} — commits made\n\`\`\`\n${gitLog}\n\`\`\`\n`);
          }
        } catch { /* no commits yet */ }
      }
    }

    lines.push(`## Instructions\nDo NOT repeat any work already completed or described above. Review the output and commits above, then continue from where the task left off.`);

    fs.writeFileSync(path.join(workspacePath, ".task-state.md"), lines.join("\n"));
  } catch (err) {
    console.error("Failed to write task state file:", err);
  }
}

// `member` names the Team member (pipeline stage) that produced the line, so the
// activity log can prefix it — null for single-agent runs and worker bookkeeping.
async function log(taskId: string, content: string, level: "info" | "error" | "system" = "info", member: string | null = null) {
  await prisma.taskLog.create({ data: { taskId, content, level, member } });
  emitTaskLog(taskId, content, level, member);
}

// Best-effort write of Task.teamProgress — the tracker on the task page is informational,
// so a failed write must never affect the pipeline itself.
async function saveTeamProgress(taskId: string, progress: TeamProgress): Promise<void> {
  try {
    await prisma.task.update({ where: { id: taskId }, data: { teamProgress: serializeTeamProgress(progress) } });
  } catch (err) {
    console.error("Failed to save team progress (non-fatal):", err);
  }
}

/**
 * Replies to whoever created this task via the inbound-email integration
 * (Task.sourceEmail) once it reaches a terminal state, closing the
 * "forward an email -> get a task -> hear back" loop. Independent of the
 * global admin notification settings — best-effort, never throws.
 */
async function notifyEmailSourceIfPresent(
  taskId: string,
  sourceEmail: string | null | undefined,
  event: "completed" | "failed",
  task: { id: string; title: string; description: string; inputTokens?: number | null; outputTokens?: number | null; estimatedCost?: number | null; model?: string | null },
  providerName: string,
  lastAIMessage: string | undefined,
  appHost: string,
) {
  if (!sourceEmail) return;
  try {
    const { transport } = await getNotificationSettings(prisma);
    const result = await sendEmailTaskResultReply(sourceEmail, event, { ...task, provider: providerName }, lastAIMessage, appHost, transport);
    if (result.sent) await log(taskId, `Reply email sent to ${sourceEmail}`, "system");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(taskId, `Reply email error: ${msg}`, "system");
    console.error("Email-source reply error (non-fatal):", err);
  }
}

interface TeamMemberForRun {
  id: string;
  name: string;
  instructions: string;
  requiresApproval?: boolean;
}

interface TeamForRun {
  id: string;
  name: string;
  members: TeamMemberForRun[];
}

// Cap on how much of one stage's output gets carried forward into the next stage's
// prompt, so a verbose stage can't blow past the next stage's context budget.
const MAX_TEAM_CARRY_FORWARD_CHARS = MAX_STAGE_OUTPUT_CHARS;

// Runs a Team's members sequentially (in `position` order), feeding each stage's
// output/context into the next one, and returns a single ExecutionResult that the
// rest of runTask's post-processing (cost accounting, git commit/PR, etc.) treats
// exactly like a single-agent run. A failure at any stage stops the pipeline
// immediately — later stages never run — and is surfaced as a clear "error"-level
// log naming the stage/member that failed, rather than silently continuing.
//
// A member with `requiresApproval` is a manual gate: once it finishes (and it isn't the
// last member) the pipeline stops and returns `awaitingApproval`, and runTask parks the
// task in "awaiting_approval". Approving (or asking for a revision) re-queues the task,
// and the next run picks up from the recorded progress — see planTeamResume().
async function runTeamPipeline(
  taskId: string,
  team: TeamForRun,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same loosely-typed task shape buildPrompt already accepts elsewhere in this file
  promptTask: any,
  provider: Provider,
  cwd: string,
  isResume: boolean,
  priorLogs: string | undefined,
  globalInstructions: string | undefined,
  enableAgentDelegation: boolean,
  getNextMessage: MessageFetcher,
  isCancelled: CancelChecker,
  onTokenUpdate: TokenUpdateCallback,
  toolAccessPrompt = "",
  agentSpan?: Pick<AgentSpanInfo, "providerType" | "requestModel" | "attributes">,
  recordedProgress: TeamProgress | null = null,
): Promise<ExecutionResult & { awaitingApproval?: boolean }> {
  const members = team.members;
  await log(taskId, `Running as Team "${team.name}" — ${members.length} stage(s): ${members.map((m) => `${m.name}${stageNeedsApproval(m, members.indexOf(m), members.length) ? " (needs approval)" : ""}`).join(" → ")}`, "system");

  // Picking up after an approval decision? Then the stages before the decision are
  // done and are not re-run. Anything else starts from the first member as before.
  const resume = isResume ? planTeamResume(recordedProgress, members, new Date()) : null;
  if (isResume && !resume && recordedProgress?.stages.some((s) => s.approval === "approved" || s.revisionFeedback)) {
    await log(taskId, "The team's members changed since the last approval, so the pipeline starts again from the first member.", "system");
  }
  const startIndex = resume?.startIndex ?? 0;

  let cumulativeInput = resume?.inputTokens ?? 0;
  let cumulativeOutput = resume?.outputTokens ?? 0;
  let previousOutput = resume?.previousOutput ?? "";
  let progress = resume?.progress ?? startTeamProgress(team, new Date());
  await saveTeamProgress(taskId, progress);
  if (resume && startIndex > 0) {
    await log(taskId, `Continuing the team pipeline at stage ${startIndex + 1}/${members.length} (${members[startIndex].name}) — earlier stages were already approved.`, "system");
  }

  for (let i = startIndex; i < members.length; i++) {
    const member = members[i];
    const isResumeStart = resume !== null && i === startIndex;
    const approvalNote = isResumeStart ? resume.approvalNote : null;
    const revision = isResumeStart ? resume.revision : null;
    const stageLabel = `Stage ${i + 1}/${members.length}: ${member.name}`;
    progress = markStageRunning(progress, i, new Date());
    await saveTeamProgress(taskId, progress);
    await log(taskId, `——— Team pipeline — ${stageLabel} ———`, "system", member.name);

    // Build this stage's context: its own role/instructions, the previous stage's
    // output (so work actually carries forward), and the task's own context/instructions
    // underneath so nothing the user wrote is lost mid-pipeline.
    const stageContext = [
      `## Team Pipeline\nYou are the "${member.name}" stage (${i + 1} of ${members.length}) of a multi-agent pipeline handling this task together. Focus only on this stage's responsibility described below — a separate stage will pick up after you, so do not try to finish the entire task yourself unless your instructions say otherwise.`,
      `### Your Instructions\n${member.instructions?.trim() || "(no specific instructions were provided for this stage — use your best judgment given the task and the role name above.)"}`,
      i > 0 ? `### Output From Previous Stage ("${members[i - 1].name}")\n${previousOutput || "(no output was captured from the previous stage)"}` : null,
      isResumeStart && resume.previousApproved
        ? `### Human Approval\nA human reviewed and approved the "${members[i - 1].name}" stage's output above before this stage was allowed to start.${approvalNote ? ` Their notes — follow them:\n${approvalNote}` : ""}`
        : null,
      revision
        ? `### Revision Requested\nYour previous attempt at this stage was reviewed by a human, who asked for changes before the pipeline continues. Redo this stage, addressing their feedback.\n\n#### Feedback\n${revision.feedback}\n\n#### Your Previous Output\n${revision.previousOutput || "(no output was captured)"}`
        : null,
      promptTask.context ? `### Additional Task Context\n${promptTask.context}` : null,
    ].filter(Boolean).join("\n\n");

    const stageTask = { ...promptTask, context: stageContext };
    // Resume instructions only make sense once, at the very start of the pipeline —
    // later stages are always a fresh forward pass within this same run. A stage that
    // starts fresh after an approval decision isn't a resume either.
    const stageIsResume = i === startIndex && isResume && !(resume?.freshStage);
    const prompt = await buildPrompt(stageTask, stageIsResume, stageIsResume ? priorLogs : undefined, globalInstructions, enableAgentDelegation);
    prompt.system = `${prompt.system}\n\nA team of agents is handling this task in sequence. You are currently playing the "${member.name}" role (stage ${i + 1} of ${members.length}). Do the work described in your instructions, then stop — do not attempt later stages.`;
    if (toolAccessPrompt) prompt.system = `${prompt.system}\n\n${toolAccessPrompt}`;

    let stageOutput = "";
    const stageOnOutput = async (chunk: string, level: "info" | "error" | "system" = "info") => {
      if (level === "info") stageOutput += (stageOutput ? "\n" : "") + chunk;
      await log(taskId, chunk, level, member.name);
    };

    const baseInput = cumulativeInput;
    const baseOutput = cumulativeOutput;
    const stageOnTokenUpdate: TokenUpdateCallback = (inp, out) => onTokenUpdate(baseInput + inp, baseOutput + out);

    // gen_ai semantic conventions: each stage is its own `invoke_agent {agent name}` span — a
    // sub-agent of the task's `invoke_agent` span — and carries that stage's usage (the
    // task's span carries none, so nothing is counted twice).
    const result = await withAgentSpan(taskId, {
      agentName: member.name,
      providerType: agentSpan?.providerType ?? "unknown",
      requestModel: agentSpan?.requestModel,
      attributes: { ...agentSpan?.attributes, "ctm.team.name": team.name, "ctm.team.stage.index": i },
    }, () => provider.execute(taskId, prompt, stageOnOutput, getNextMessage, cwd, isCancelled, stageOnTokenUpdate));

    cumulativeInput += result.inputTokens ?? 0;
    cumulativeOutput += result.outputTokens ?? 0;
    const stageDetails = { output: stageOutput, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0 };

    if (!result.success) {
      // A rate limit / dead login (shouldRetry, authFailed) parks the task to resume
      // later, so the stage is left "running" — the tracker shows it as paused. Only a
      // genuine failure ends the run here.
      if (!result.shouldRetry && !result.authFailed) {
        progress = markStageEnded(progress, i, "failed", result.error ?? null, new Date(), stageDetails);
        await saveTeamProgress(taskId, progress);
      }
      await log(taskId, `Team pipeline stopped: ${stageLabel} failed${result.error ? ` — ${result.error}` : "."} Later stages were not run.`, "error", member.name);
      return { ...result, inputTokens: cumulativeInput, outputTokens: cumulativeOutput };
    }

    if (result.budgetExceeded) {
      progress = markStageEnded(progress, i, "stopped", "Budget reached", new Date(), stageDetails);
      await saveTeamProgress(taskId, progress);
      await log(taskId, `Team pipeline stopped early: budget reached during ${stageLabel}. Later stages were not run.`, "system", member.name);
      return { ...result, inputTokens: cumulativeInput, outputTokens: cumulativeOutput };
    }

    previousOutput = stageOutput.length > MAX_TEAM_CARRY_FORWARD_CHARS
      ? `${stageOutput.slice(0, MAX_TEAM_CARRY_FORWARD_CHARS)}\n\n*(truncated)*`
      : stageOutput;

    if (stageNeedsApproval(member, i, members.length)) {
      progress = markStageAwaitingApproval(progress, i, new Date(), stageDetails);
      await saveTeamProgress(taskId, progress);
      await log(taskId, `——— Team pipeline — ${stageLabel} complete. Waiting for manual approval before "${members[i + 1].name}" starts. Approve it (or request changes) from the task page. ———`, "system", member.name);
      return { success: true, shouldRetry: false, awaitingApproval: true, inputTokens: cumulativeInput, outputTokens: cumulativeOutput };
    }

    progress = markStageCompleted(progress, i, new Date(), stageDetails);
    await saveTeamProgress(taskId, progress);
    await log(taskId, `——— Team pipeline — ${stageLabel} complete ———`, "system", member.name);
  }

  return { success: true, shouldRetry: false, inputTokens: cumulativeInput, outputTokens: cumulativeOutput };
}

/**
 * Read `.subtasks.json` from the task's workspace (written by an agent running with
 * "Allow subtasks") and create one Task per entry. Each subtask inherits the parent's
 * repos (or the subset the agent named), provider/model, priority, effort, tool access,
 * team, labels, output type and PR/push settings, but never `allowSubtasks` itself, so
 * fan-out is one level deep. The file is renamed afterwards so re-running the parent
 * doesn't create the same subtasks again. Never throws — a problem here is logged and
 * leaves the parent's own result alone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runTask() task row, include: { repos }
async function createRequestedSubtasks(task: any): Promise<void> {
  const taskId: string = task.id;
  const filePath = path.join(getWorkspacePath(taskId), SUBTASKS_FILE);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch {
    return; // agent didn't ask for any
  }

  try {
    const parentRepos: { alias: string; url: string; branch?: string | null }[] = task.repos;
    const { subtasks, warnings } = parseSubtaskRequests(raw, parentRepos.map((r) => r.alias));
    for (const w of warnings) await log(taskId, `Subtasks: ${w}`, "system");

    const maxPos = await prisma.task.aggregate({ _max: { position: true } });
    let position = (maxPos._max.position ?? -1) + 1;
    let previousId: string | null = null;
    const created: { id: string; title: string }[] = [];
    for (const req of subtasks) {
      const repos = req.repos ? parentRepos.filter((r) => req.repos!.includes(r.alias)) : parentRepos;
      const sub: { id: string; title: string } = await prisma.task.create({
        data: {
          title: req.title,
          description: req.description,
          context: buildSubtaskContext({ id: taskId, title: task.title }, req.context),
          parentTaskId: taskId,
          allowSubtasks: false,
          provider: task.provider,
          model: task.model,
          aiProviderId: task.aiProviderId || null,
          useSmartProvider: Boolean(task.useSmartProvider),
          outputType: task.outputType,
          priority: task.priority,
          effort: task.effort,
          toolAccess: task.toolAccess ?? null,
          teamId: task.teamId ?? null,
          labels: task.labels ?? null,
          systemPrompt: task.systemPrompt ?? null,
          tokenBudget: task.tokenBudget ?? null,
          costBudget: task.costBudget ?? null,
          createPR: Boolean(task.createPR),
          pushToMain: Boolean(task.pushToMain),
          // Never share the parent's fixed target branch: parallel subtasks pushing to
          // one branch would fight each other. Each gets its own agent branch.
          targetBranch: null,
          dependsOnTaskId: req.dependsOnPrevious && previousId ? previousId : null,
          position: position++,
          repos: {
            create: repos.map((r) => ({ alias: r.alias, url: r.url, branch: r.branch || null })),
          },
        },
        select: { id: true, title: true },
      });
      created.push(sub);
      previousId = sub.id;
    }

    await fs.promises.rename(filePath, path.join(getWorkspacePath(taskId), SUBTASKS_PROCESSED_FILE)).catch(() => {});
    if (created.length > 0) {
      await log(taskId, `Created ${created.length} subtask(s):\n${created.map((c) => `- ${c.title} (${c.id})`).join("\n")}`, "system");
    } else {
      await log(taskId, `Subtasks: ${SUBTASKS_FILE} contained no valid subtasks — nothing created.`, "system");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(taskId, `Warning: failed to create subtasks: ${msg}`, "system");
    console.error("Subtask creation error (non-fatal):", err);
  }
}

/**
 * Stored credentials of every provider except `excludeId`.
 *
 * Only used as an identity hint when pushing credentials into a config dir that has no owner
 * marker yet (installs that predate it): a file whose bytes are exactly another connection's
 * stored login is certainly not a rotation of ours, so it gets overwritten rather than
 * inherited. See src/lib/providers/cli-credentials.ts.
 */
async function otherProviderCredentials(excludeId: string): Promise<(string | null)[]> {
  try {
    const rows = await prisma.aIProvider.findMany({
      where: { id: { not: excludeId } },
      select: { credentialsJson: true },
    });
    return rows.map((r: { credentialsJson: string | null }) => r.credentialsJson);
  } catch {
    return [];
  }
}

/**
 * `getProvider()`, but never hands back a provider that has reached its usage cap
 * (`maxUsagePercent`). An over-cap provider is marked throttled until its window resets and
 * resolution runs again, so the usual fall-through (smart pick → default → any enabled → hold
 * for the soonest reset) picks the next best option. Bounded so a misbehaving lookup can't spin.
 */
async function getProviderWithinUsageCap(
  taskId: string,
  options: Parameters<typeof getProvider>[0],
): Promise<Awaited<ReturnType<typeof getProvider>>> {
  let result = await getProvider(options);
  for (let i = 0; i < 10 && result.provider; i++) {
    const capped = await enforceUsageCap(result.provider);
    if (!capped) return result;
    await log(taskId, describeUsageCapHit(result.provider.name, capped), "system");
    result = await getProvider(options);
  }
  return result;
}

async function runTask(taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      repos: true,
      aiProvider: true,
      // Only populated when the task runs as a Team pipeline (task.teamId set) — see
      // the "Team pipeline" section further down and runTeamPipeline() above.
      team: { include: { members: { orderBy: { position: "asc" } } } },
    },
  });
  if (!task) return;
  // Review-only tickets never run (the pick-up query already skips them); this guards
  // any other path into runTask() so one can't spend tokens or touch its status.
  if (task.reviewOnly) return;

  // Resolve the AI provider before doing any workspace/repo setup. If it's already known to
  // be throttled — either proactively, from the periodic usage check in refreshCliCredentials
  // noticing a subscription is at 100% usage (and when it'll reset), or reactively from a
  // previous run that hit a rate limit — stop right here instead of cloning repos, flipping
  // the task to "running", and only discovering the outage after spawning a doomed CLI call.
  const autoSwitchSetting = await prisma.setting.findUnique({ where: { key: "auto_switch_provider" } });
  const autoSwitch = autoSwitchSetting?.value !== "false"; // default: on

  const providerOptions = {
    explicitProviderId: task.aiProviderId,
    useSmartProvider: task.useSmartProvider,
    autoSwitch,
  };
  let { provider: preflightProvider, throttledFallback } = await getProviderWithinUsageCap(taskId, providerOptions);

  // A throttle is a cached verdict from whenever the provider last hit a limit — the window may
  // have reset, or usage credits may have been switched on, since. Confirm it against live usage
  // before parking anything; otherwise a resumed task bounces straight back to "throttled".
  if (!preflightProvider && throttledFallback && !(await revalidateProviderThrottle(throttledFallback))) {
    ({ provider: preflightProvider, throttledFallback } = await getProviderWithinUsageCap(taskId, providerOptions));
  }

  if (preflightProvider && preflightProvider.id !== task.aiProviderId) {
    if (task.aiProviderId) {
      // Name the reason: "disabled or throttled" left users unable to tell whether the
      // provider they switched off was the one being skipped or the one being used.
      const requested = await prisma.aIProvider.findUnique({ where: { id: task.aiProviderId } });
      const why = !requested
        ? "no longer exists"
        : !requested.isEnabled
        ? "is disabled"
        : requested.throttledUntil
        ? `is rate-limited until ${new Date(requested.throttledUntil).toISOString()}`
        : "is unavailable";
      await log(taskId, `Requested provider${requested ? ` "${requested.name}"` : ""} ${why}. Using "${preflightProvider.name}" instead.`, "system");
    }
    task.aiProviderId = preflightProvider.id;
    await prisma.task.update({ where: { id: taskId }, data: { aiProviderId: preflightProvider.id } });
  }

  // getProvider only ever returns a provider that's usable right now, so anything else means
  // no capacity anywhere. A throttled fallback isn't "no provider configured" — it's a real
  // connection waiting on its rate limit — so hold the task for it rather than failing.
  if (!preflightProvider) {
    if (throttledFallback?.throttledUntil) {
      await log(taskId, `Provider "${throttledFallback.name}" is throttled (resets ${throttledFallback.throttledUntil.toISOString()}) and no other provider is available. Holding task until it resets instead of starting.`, "system");
      task.aiProviderId = throttledFallback.id;
      await writeTaskStateFile(taskId, task.title, task.repos, "Provider throttled — checked before starting");
      await prisma.task.update({
        where: { id: taskId },
        data: { aiProviderId: throttledFallback.id, status: "throttled", nextRetryAt: throttledFallback.throttledUntil },
      });
      return;
    }

    await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
    await log(taskId, "No AI provider configured. Add one in Settings → AI.", "error");
    return;
  }

  const isResume = shouldResumeTask(task);

  await prisma.task.update({ where: { id: taskId }, data: { status: "running", hasConflict: false, conflictMessage: null } });
  await log(taskId, isResume ? `Resuming task: ${task.title}` : `Starting task: ${task.title}`, "system");

  let priorLogs: string | undefined;
  if (isResume) {
    const logs = await prisma.taskLog.findMany({
      where: { taskId, level: "info" },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    if (logs.length > 0) {
      priorLogs = logs.reverse().map((l: { content: string; member: string | null }) => l.content.trim() && `${memberLogPrefix(l.member)}${l.content.trim()}`).filter(Boolean).join("\n");
    }
  }

  const globalInstructionsSetting = await prisma.setting.findUnique({ where: { key: "global_agent_instructions" } });
  const globalInstructions = globalInstructionsSetting?.value?.trim() || undefined;

  // Agent delegation (subagents choosing their own model per sub-task) only works
  // through the Claude CLI's native Task/Agent tool — the hand-rolled ApiProvider/
  // OpenAIProvider tool loops don't expose an equivalent, so only enable the
  // guidance when the provider that will actually run this task is "cli". Uses the
  // preflight resolution above rather than the post-repo-setup one below since the
  // prompt is built before that later resolution runs; the two only disagree in the
  // rare case a provider goes down mid-clone, which is harmless here (the CLI simply
  // won't offer the tool the prompt describes).
  const agentDelegationSetting = await prisma.setting.findUnique({ where: { key: "agent_delegation_enabled" } });
  const agentDelegationEnabled = agentDelegationSetting?.value !== "false"; // default: on
  const enableAgentDelegation = agentDelegationEnabled && preflightProvider?.type === "cli";
  // prompt is built after repo setup so pre-rebase outcome can update the context

  // Used below as the source branch to clone from whenever a repo wasn't given an explicit
  // branch at task-creation time, so a task with no branch specified starts from the same
  // branch its PR will ultimately target instead of whatever the remote's HEAD happens to be.
  const { defaultBaseBranch: gitDefaultBaseBranch } = await loadGitProviderSettings();

  await ensureWorkspace(taskId);

  const isFileOutput = isFileBasedOutput(task.outputType);
  // File, design and inline-result tasks all treat repos as read-only context —
  // no agent branch, no commit/push, no PR. Only file-based outputs scan output/.
  const isReadOnly = isReadOnlyOutput(task.outputType);

  // For file output tasks, create the output directory upfront
  if (isFileOutput) {
    const outputDir = path.join(getWorkspacePath(taskId), "output");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  }

  const slug = task.title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 40).replace(/-+$/, "");

  // targetBranch: work on that branch and push back to it
  // pushToMain: work on main and push back to main
  // default: create a new agent branch
  const workOnExistingBranch = task.targetBranch || task.pushToMain;
  const branch = task.targetBranch ?? (task.pushToMain ? gitDefaultBaseBranch : branchName(taskId, slug));

  let hasErrors = false;
  // Set once the repo-commit loop below runs — true when the task has git repos,
  // isn't a file-output task, and none of those repos had anything to commit. Used
  // to report "no_changes" instead of "completed" (see status update near the end
  // of this function) so a run that genuinely made no code changes isn't confused
  // with a PR-creation failure or a generic success.
  let noChangesOnly = false;
  let effectiveContext = task.context;

  // A resumed agent branch that couldn't be rebased cleanly onto the latest base branch
  // is left on its old base; tell the agent so the PR doesn't go up with conflicts.
  // (Skipped for "Make Branch Mergeable" runs, which already rebase explicitly below.)
  const noteBaseConflict = (alias: string, baseBranch: string) => {
    if (task.context?.includes("## Make Branch Mergeable")) return;
    effectiveContext = `${effectiveContext ? `${effectiveContext}\n\n` : ""}## Base Branch Has Moved (${alias})\nThe \`${alias}\` repo's branch was created from an older \`${baseBranch}\`, and rebasing it onto the latest \`origin/${baseBranch}\` hit conflicts, so the worker left it on its previous base. Before finishing, run \`git fetch origin ${baseBranch} && git rebase origin/${baseBranch}\` in that repo and resolve the conflicts (keeping both the upstream changes and this task's intent) so the pull request merges cleanly.`;
  };

  for (const repo of task.repos) {
    try {
      await log(taskId, `Setting up repo: ${repo.alias}`, "system");
      const repoDest = getRepoDest(taskId, repo.alias);
      // Determine the source branch to clone from for this repo. If none was given at task
      // creation, fall back to the configured default PR base branch (Settings > Git) rather
      // than letting the clone silently pick up the remote's default branch — otherwise the
      // agent could branch off a different commit than the one its PR is later opened against.
      const repoBranch = (repo as { branch?: string | null }).branch || gitDefaultBaseBranch;

      if (isReadOnly) {
        // For file/result output tasks, clone repos as read-only context only — no branch creation
        if (!isResume || !fs.existsSync(path.join(repoDest, ".git"))) {
          await cloneRepo(repo.url, taskId, repo.alias, repoBranch);
          await log(taskId, `Cloned ${repo.alias} for context (read-only)`, "system");
        } else {
          await log(taskId, `Using existing workspace for context: ${repo.alias}`, "system");
        }
      } else {
        const cloneBranch = workOnExistingBranch ? branch : repoBranch;
        if (isResume && fs.existsSync(path.join(repoDest, ".git"))) {
          await log(taskId, `Resuming with existing workspace for ${repo.alias}`, "system");
          const git = await openRepo(repoDest, repo.url);
          // A resumed task may have been cloned long ago (retried, paused, or sent back to
          // the backlog), so for agent branches also rebase onto the *current* base branch
          // — otherwise the work lands on a stale base and the PR conflicts. Tasks working
          // directly on an existing branch only pull that branch.
          const syncBase = workOnExistingBranch ? undefined : await resolveBaseBranch(git, repoBranch);
          const syncResult = await pullAndSyncWorkingRepo(git, branch, syncBase);
          await log(taskId, `Repo sync: ${syncResult.message}`, "system");
          if (syncResult.baseConflict && syncBase) noteBaseConflict(repo.alias, syncBase);
          if (syncResult.hadConflicts) {
            await prisma.task.update({
              where: { id: taskId },
              data: { hasConflict: true, conflictMessage: `${repo.alias}: ${syncResult.message}` },
            });
            await log(taskId, `Merge conflict detected while syncing ${repo.alias}`, "error");
          }

          if (task.context?.includes("## Make Branch Mergeable")) {
            const baseBranch = await resolveBaseBranch(git, repoBranch);
            const rebaseResult = await rebaseOntoBase(git, baseBranch);
            await log(taskId, `Pre-rebase: ${rebaseResult.message}`, "system");

            const sectionRegex = /## Make Branch Mergeable[\s\S]*?(?=\n##\s|$)/;
            if (rebaseResult.clean) {
              effectiveContext = (effectiveContext ?? "").replace(sectionRegex, `## Make Branch Mergeable\nDone. The worker already rebased this branch onto \`origin/${baseBranch}\` cleanly. Stop here — do not review code, make changes, or do any other work.`);
            } else if (rebaseResult.hadConflicts) {
              effectiveContext = (effectiveContext ?? "").replace(sectionRegex, `## Make Branch Mergeable\nThe worker has already started a rebase onto \`origin/${baseBranch}\`. The rebase is in progress with conflicts. Your only job:\n1. Run \`git status\` to see conflicted files.\n2. Open each conflicted file, resolve the \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers preserving both sides.\n3. \`git add <file>\` each resolved file.\n4. Run \`git rebase --continue\` — repeat if more conflicts appear.\n5. Stop as soon as the rebase finishes. Do NOT fetch, do NOT start a new rebase, do NOT make any other changes.`);
            }
          }
        } else {
          // On resume with no local workspace, try cloning the existing agent branch so prior
          // commits are present. cloneRepo falls back to the default branch if it doesn't exist.
          // When that agent branch was never pushed, start from the task's base branch
          // (not origin's default) so the agent builds on the branch its PR targets.
          const resumeCloneBranch = (isResume && !workOnExistingBranch) ? branch : cloneBranch;
          const git = await cloneRepo(repo.url, taskId, repo.alias, resumeCloneBranch, repoBranch);
          if (isResume && !workOnExistingBranch && (await git.branch()).current === branch) {
            // Cloned the previously pushed agent branch — bring it up to date with the base.
            const syncBase = await resolveBaseBranch(git, repoBranch);
            const baseResult = await syncWithBaseBranch(git, syncBase);
            await log(taskId, `Repo sync: ${baseResult.message}`, "system");
            if (baseResult.hadConflicts) noteBaseConflict(repo.alias, syncBase);
          }
          if (!workOnExistingBranch) {
            // Only create a fresh local branch if we didn't successfully clone the agent branch
            const currentBranch = (await git.branch()).current;
            if (currentBranch !== branch) {
              await createAndCheckoutBranch(git, branch);
            }
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(taskId, `Repo setup error for ${repo.alias}: ${msg}`, "error");
      hasErrors = true;
    }
  }

  if (hasErrors) {
    await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
    await log(taskId, "Task failed due to repo setup errors.", "error");
    return;
  }

  if (!isReadOnly && task.repos.length > 0 && !workOnExistingBranch) {
    await prisma.task.update({ where: { id: taskId }, data: { branchName: branch } });
  }

  // Snapshot each repo's baseline sha right before the agent runs. The system prompt
  // tells the agent to "commit your changes regularly... but do NOT push" (see
  // CODING_SYSTEM_PROMPT in prompt-builder.ts), so by the time the final commit step
  // below runs, the agent has often already committed everything itself and the
  // working tree is clean. commitAll() alone would then report hadChanges: false — a
  // false "no changes" even though the branch now has real commits ahead of this
  // baseline. Comparing post-run HEAD against this baseline is what lets us tell
  // "agent already committed" apart from "truly no changes".
  //
  // The baseline must be origin's ref, not the local workspace's HEAD. On a resumed
  // task, the local workspace can already contain a commit that never made it to
  // origin — either the agent committed but the run then crashed/timed out/was killed
  // before the push step below, or (as happened for task cms4t99ej — see incident)
  // pullAndSyncWorkingRepo's own "checkpoint before resume sync" commit turns a prior
  // run's leftover dirty tree into a real commit during THIS run's setup, which
  // completes before this snapshot is taken. Either way, a local-HEAD snapshot taken
  // now would already include that commit, making the later diff see "no changes"
  // even though nothing was ever pushed or recorded. Falls back to origin's ref for
  // the branch this one was cloned from (repoBranch) when `branch` itself doesn't
  // exist on origin yet — e.g. a brand-new agent branch on its first run.
  const baseHeadShaMap: Record<string, string> = {};
  if (!isReadOnly && task.repos.length > 0) {
    const { simpleGit } = await import("simple-git");
    // Each iteration is a network round-trip (`git ls-remote`) with no dependency on
    // any other repo's result, so run them concurrently rather than one at a time —
    // on a multi-repo task this previously added a full round-trip of latency per
    // extra repo, serialized, before the agent could even start.
    await Promise.all(task.repos.map(async (repo: { alias: string; branch?: string | null }) => {
      try {
        const repoDest = getRepoDest(taskId, repo.alias);
        const git = simpleGit(repoDest).env(safeEnv());
        const branchRef = await git.raw(["ls-remote", "--heads", "origin", branch]).catch(() => "");
        const ref = branchRef.trim()
          || (await git.raw(["ls-remote", "--heads", "origin", await resolveBaseBranch(git, repo.branch || gitDefaultBaseBranch)]).catch(() => "")).trim();
        const sha = ref ? ref.split(/\s+/)[0] : undefined;
        if (sha) {
          baseHeadShaMap[repo.alias] = sha;
        } else {
          // Origin unreachable / ref missing. Fall back to the local HEAD so commits the
          // agent makes itself are still detected — without any baseline, only a dirty
          // tree counts as a change and an agent that committed everything would be
          // reported as "no changes" with nothing pushed for review.
          const localHead = (await git.revparse(["HEAD"]).catch(() => "")).trim();
          if (localHead) {
            baseHeadShaMap[repo.alias] = localHead;
          } else {
            // No local commit either. If origin answers but has no branches at all, the repo
            // is brand new and empty — every commit the agent makes is new work.
            const anyHeads = await git.raw(["ls-remote", "--heads", "origin"]).then((out) => out.trim(), () => null);
            if (anyHeads === "") baseHeadShaMap[repo.alias] = EMPTY_REPO_BASELINE;
          }
        }
      } catch {
        // Best-effort — if this fails we just fall back to commitAll's dirty-tree check below.
      }
    }));
  }

  const isRebaseOnly = task.context?.includes("## Make Branch Mergeable");
  const isReviewPr = task.context?.includes(REVIEW_PR_MARKER);
  const promptTask = isRebaseOnly
    ? { ...task, context: effectiveContext, description: "Follow the instructions in the Context section exactly. Do nothing else." }
    : isReviewPr
    ? { ...task, context: effectiveContext, description: "Review the pull request for this task per the instructions in the Context section, make any necessary changes, and end with a PR review comment." }
    : { ...task, context: effectiveContext };
  const prompt = await buildPrompt(promptTask, isResume, priorLogs, globalInstructions, enableAgentDelegation);

  // Surface the verification carry-over so it's visible why a resumed run skips
  // a rebuild (or why it doesn't).
  if (isResume) {
    const recorded = readVerifications(getWorkspacePath(taskId));
    if (recorded.length > 0) {
      await log(taskId, `Carrying over ${recorded.length} recorded check(s) from earlier runs: ${recorded.map((v) => `${v.command} (${v.status})`).join(", ")}`, "system");
    }
  }

  // If this task runs as a Team pipeline (see the "Team" toggle on the new-task form),
  // validate the team/roster right here — fail clearly instead of silently falling back
  // to single-agent execution when the team was deleted or left empty after the task
  // was created.
  let teamForPipeline: TeamForRun | null = null;
  if (task.teamId) {
    const team = (task as { team?: TeamForRun | null }).team ?? null;
    if (!team) {
      await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
      await log(taskId, "Team pipeline configuration error: the team assigned to this task no longer exists. Assign a different team or remove it from this task, then retry.", "error");
      return;
    }
    if (team.members.length === 0) {
      await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
      await log(taskId, `Team pipeline configuration error: team "${team.name}" has no members. Add at least one member in Teams before running this task, then retry.`, "error");
      return;
    }
    teamForPipeline = team;
  }

  const timeoutSetting = await prisma.setting.findUnique({ where: { key: "task_timeout_minutes" } });
  const timeoutMinutes = timeoutSetting?.value ? parseInt(timeoutSetting.value, 10) : 60;
  const timeoutDisabled = timeoutMinutes === 0;
  const timeoutMs = timeoutDisabled ? 0 : (isNaN(timeoutMinutes) || timeoutMinutes < 1 ? 60 : timeoutMinutes) * 60000;

  const maxOutputTokensSetting = await prisma.setting.findUnique({ where: { key: "claude_code_max_output_tokens" } });
  const maxOutputTokensParsed = maxOutputTokensSetting?.value ? parseInt(maxOutputTokensSetting.value, 10) : undefined;
  const maxOutputTokens = maxOutputTokensParsed && !isNaN(maxOutputTokensParsed) && maxOutputTokensParsed > 0 ? maxOutputTokensParsed : undefined;

  // Re-resolve rather than reusing the preflight result: repo setup above can take minutes,
  // during which a provider may have been disabled or hit a rate limit.
  const preSpawnOptions = {
    explicitProviderId: task.aiProviderId,
    useSmartProvider: task.useSmartProvider,
    autoSwitch,
  };
  let {
    provider: resolvedAIProvider,
    source: providerSource,
    throttledFallback: preSpawnThrottled,
  } = await getProviderWithinUsageCap(taskId, preSpawnOptions);

  // Same re-check as the pre-flight above: don't shelve a task that's already had its repos
  // cloned on the strength of a throttle that may no longer hold.
  if (!resolvedAIProvider && preSpawnThrottled && !(await revalidateProviderThrottle(preSpawnThrottled))) {
    ({
      provider: resolvedAIProvider,
      source: providerSource,
      throttledFallback: preSpawnThrottled,
    } = await getProviderWithinUsageCap(taskId, preSpawnOptions));
  }

  // Persist the resolved provider onto the task row so the UI (which reads
  // task.aiProviderId / task.aiProvider) reflects the provider actually used instead of
  // silently falling back to displaying the org's default provider as "(default)".
  if (resolvedAIProvider && resolvedAIProvider.id !== task.aiProviderId) {
    await prisma.task.update({ where: { id: taskId }, data: { aiProviderId: resolvedAIProvider.id } });
  }

  if (!resolvedAIProvider) {
    // Capacity can disappear during repo setup, which runs for minutes. Hold the task for the
    // reset rather than failing work that's already been set up.
    if (preSpawnThrottled?.throttledUntil) {
      await log(taskId, `Provider "${preSpawnThrottled.name}" became throttled during setup (resets ${preSpawnThrottled.throttledUntil.toISOString()}). Holding task until it resets.`, "system");
      await writeTaskStateFile(taskId, task.title, task.repos, "Provider throttled — checked before spawning");
      await prisma.task.update({
        where: { id: taskId },
        data: { aiProviderId: preSpawnThrottled.id, status: "throttled", nextRetryAt: preSpawnThrottled.throttledUntil },
      });
      return;
    }
    await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
    await log(taskId, providerUnavailableMessage(preSpawnThrottled), "error");
    return;
  }

  const providerMode = resolvedAIProvider.type as "cli" | "api" | "openai" | "claude-pki" | "codex-cli";
  const apiKey = resolvedAIProvider.apiKey || undefined;
  const baseURL = resolvedAIProvider.baseUrl || undefined;
  const settingsModel = resolvedAIProvider.model || undefined;
  const configDir = resolvedAIProvider.configDir || undefined;
  const providerName = resolvedAIProvider.name;
  // The task's model was chosen against whichever provider was pinned when it was created,
  // and that provider may not be the one running it now — a smart pick or a throttle
  // fallback can move a task between vendors, and `codex-cli` joining the CLI tier makes
  // that a routine occurrence. Handing `claude-opus-5-5` to `codex exec` (or `gpt-5.6-sol` to
  // the Claude CLI) is a guaranteed hard failure, so drop the mismatch and let the provider
  // use its own default instead. Unrecognised ids still pass through untouched, since
  // proxied/self-hosted deployments legitimately use arbitrary model names.
  let taskModel = task.model || undefined;
  if (taskModel && !modelFitsProvider(taskModel, providerMode)) {
    await log(taskId, `Task model "${taskModel}" isn't a ${providerMode} model — using provider "${providerName}"'s default instead.`, "system");
    taskModel = undefined;
  }
  const pkiCert = resolvedAIProvider.pkiCertData ? Buffer.from(resolvedAIProvider.pkiCertData) : undefined;
  const pkiPassphrase = resolvedAIProvider.pkiCertPassphrase || undefined;
  const proxyUrl = resolvedAIProvider.proxyUrl || undefined;

  if (providerMode === "claude-pki" && !pkiCert) {
    await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
    await log(taskId, `Provider "${providerName}" is a Claude PKI provider but has no .p12 certificate uploaded. Add one in Settings → AI.`, "error");
    return;
  }

  // For CLI providers: write credentials from DB to disk so the CLI can authenticate as the
  // provider we resolved above — and not as whichever connection happened to write into a
  // shared config dir last.
  if (providerMode === "cli" && resolvedAIProvider.credentialsJson && configDir) {
    try {
      // Ownership-aware (see src/lib/providers/cli-credentials.ts): the freshness guard only
      // applies to a rotation of *this* provider's own token. A config dir shared with
      // another connection — the default when configDir is left blank — is overwritten, so a
      // task can't end up running on the account of a provider the user switched off.
      const decision = syncCredentialsToDisk({
        providerId: resolvedAIProvider.id,
        dir: configDir,
        fileName: ".credentials.json",
        credentialsJson: resolvedAIProvider.credentialsJson,
        expiresAtOf: extractExpiresAt,
        otherProviderCredentials: await otherProviderCredentials(resolvedAIProvider.id),
      });
      if (!decision.write) {
        await log(taskId, `Using the credentials already in ${configDir} (${decision.reason}).`, "system");
      }
    } catch (err) {
      await log(taskId, `Warning: failed to write credentials to disk: ${err instanceof Error ? err.message : String(err)}`, "system");
    }
  }

  if (providerMode === "codex-cli") {
    // Nothing below can work without the binary, and the failure is entirely non-obvious
    // from a task log full of ENOENT — check once, up front, with an actionable message.
    if (!findCodexBinary()) {
      await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
      await log(taskId, `Provider "${providerName}" is a Codex CLI provider, but the binary isn't available to the worker. ${CODEX_NOT_FOUND_MESSAGE}`, "error");
      return;
    }
    if (resolvedAIProvider.credentialsJson) {
      try {
        // Same ownership rule as the Claude CLI above — CODEX_HOME is just as shareable.
        syncCredentialsToDisk({
          providerId: resolvedAIProvider.id,
          dir: resolveCodexHome(configDir),
          fileName: "auth.json",
          credentialsJson: resolvedAIProvider.credentialsJson,
          expiresAtOf: extractCodexExpiresAt,
          otherProviderCredentials: await otherProviderCredentials(resolvedAIProvider.id),
        });
      } catch (err) {
        await log(taskId, `Warning: failed to write Codex auth.json: ${err instanceof Error ? err.message : String(err)}`, "system");
      }
    }
  }

  // Determine effective model for cost/token calculations
  const liveEffectiveModel = taskModel || settingsModel || (providerMode === "api" || providerMode === "claude-pki" ? DEFAULT_ASSISTANT_MODEL : providerMode === "openai" ? "gpt-4o" : providerMode === "codex-cli" ? DEFAULT_CODEX_MODEL : "");

  // Convert cost budget to token budget if provided
  let maxTokens: number | undefined = task.tokenBudget ?? undefined;
  if (task.costBudget && !maxTokens) {
    const pricing = findPricing(liveEffectiveModel);
    if (pricing) {
      // Use output token price (more expensive per token) for a conservative estimate
      const pricePerToken = pricing.outputPerMTok / 1_000_000;
      maxTokens = Math.floor(task.costBudget / pricePerToken);
    }
  }

  const budgetLabel = task.costBudget
    ? ` | Cost budget: $${task.costBudget.toFixed(2)}${maxTokens ? ` (~${maxTokens.toLocaleString()} tokens)` : ""}`
    : task.tokenBudget ? ` | Token budget: ${task.tokenBudget.toLocaleString()}` : "";

  const smartPickLabel = providerSource === "smart" ? " [smart-picked]" : providerSource === "fallback" ? " [fallback]" : "";
  const effortLabel = normalizeEffort(task.effort) ? ` | Effort: ${normalizeEffort(task.effort)}` : "";
  await log(taskId, `Provider: ${providerName} (${providerMode})${smartPickLabel} | Timeout: ${timeoutDisabled ? "disabled" : `${Math.round(timeoutMs / 60000)} min`} | Model: ${taskModel || settingsModel || "default"}${budgetLabel}${effortLabel}`, "system");

  await log(taskId, `Provider: ${providerMode} | Timeout: ${timeoutDisabled ? "disabled" : `${Math.round(timeoutMs / 60000)} min`} | Model: ${taskModel || settingsModel || "default"}${task.tokenBudget ? ` | Token budget: ${task.tokenBudget.toLocaleString()}` : ""}`, "system");

  await log(taskId, `Provider: ${providerMode} | Timeout: ${timeoutDisabled ? "disabled" : `${Math.round(timeoutMs / 60000)} min`} | Model: ${taskModel || settingsModel || "default"}${task.tokenBudget ? ` | Token budget: ${task.tokenBudget.toLocaleString()}` : ""}`, "system");

  // Per-task external tool access (Settings → Agent Tools + the task's own overrides):
  // tokens for granted CLIs, stripped credentials + a PATH shim for denied ones. See
  // src/lib/agent-tools.ts. Failing to prepare it fails the task rather than running
  // the agent with access nobody granted.
  let agentTools: PreparedAgentTools;
  try {
    agentTools = await prepareAgentTools(taskId, task.toolAccess);
  } catch (err) {
    const msg = `Failed to prepare agent tool access: ${err instanceof Error ? err.message : String(err)}`;
    await log(taskId, msg, "error");
    await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
    return;
  }
  if (agentTools.summary.length > 0) await log(taskId, `Tool access — ${agentTools.summary.join(" | ")}`, "system");
  if (agentTools.promptSection) prompt.system = `${prompt.system}\n\n${agentTools.promptSection}`;

  // External MCP servers (Settings → MCP Servers): every enabled server is handed to
  // the agent CLI. A broken config is logged and skipped rather than failing the task —
  // unlike tool access, leaving MCP servers out never widens what the agent can do.
  let mcpServers: PreparedMcpServers = { mcp: undefined, promptSection: "", summary: "", cleanup: async () => {} };
  try {
    mcpServers = await prepareMcpServers(taskId, providerMode);
  } catch (err) {
    await log(taskId, `Failed to prepare MCP servers, continuing without them: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  if (mcpServers.summary) await log(taskId, mcpServers.summary, "system");
  if (mcpServers.promptSection) prompt.system = `${prompt.system}\n\n${mcpServers.promptSection}`;

  // "Allow subtasks" (Advanced Options): tell the agent it may queue follow-up tasks via
  // .subtasks.json. Rebase-only / PR-review runs are maintenance passes on existing work,
  // so they never get it. The worker turns the file into tasks after a successful run —
  // see createRequestedSubtasks().
  const subtasksPrompt = task.allowSubtasks && !isRebaseOnly && !isReviewPr
    ? buildSubtasksPromptSection(getWorkspacePath(taskId), task.repos.map((r: { alias: string }) => r.alias))
    : "";
  if (subtasksPrompt) {
    prompt.system = `${prompt.system}\n\n${subtasksPrompt}`;
    await log(taskId, `Subtask creation enabled — the agent can queue follow-up tasks via ${SUBTASKS_FILE}`, "system");
  }

  const provider = createProvider(providerMode, {
    agentEnv: agentTools.env,
    mcp: mcpServers.mcp,
    apiKey,
    model: taskModel || settingsModel,
    baseURL,
    timeoutMs,
    maxTokens,
    configDir,
    maxOutputTokens,
    pkiCert,
    pkiPassphrase,
    proxyUrl,
    effort: normalizeEffort(task.effort) ?? undefined,
  });

  const getNextMessage = async () => {
    const msg = await prisma.taskMessage.findFirst({
      where: { taskId, sentAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (!msg) return null;
    await prisma.taskMessage.update({ where: { id: msg.id }, data: { sentAt: new Date() } });
    // Note: the "user" TaskLog entry is already written by POST /api/tasks/[id]/message
    // at send time (so it shows up immediately in the UI). Don't log it again here —
    // this just marks the message consumed and hands its content to the provider to
    // inject into the live conversation.
    return { id: msg.id, content: msg.content };
  };

  const isCancelled = async () => {
    const t = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
    return t?.status === "killed";
  };

  await log(taskId, `Executing task with ${task.repos.length} repo(s). Workspace: ${getWorkspacePath(taskId)}`, "system");

  // Image attachments (pasted / dropped screenshots) go into the workspace once, here,
  // for every provider type and before any team stage runs — the prompt already tells
  // the agent they're there, so a file we couldn't copy is logged rather than skipped.
  if (prompt.attachments && prompt.attachments.length > 0) {
    const copiedAttachments = copyAttachmentsToWorkspace(prompt.attachments, getWorkspacePath(taskId), task.attachmentsFolder);
    if (copiedAttachments.copied.length > 0) {
      await log(taskId, `Attached image(s) copied into the workspace: ${copiedAttachments.copied.join(", ")}`, "system");
    }
    for (const miss of copiedAttachments.missing) {
      await log(taskId, `Attached image "${miss.name}" could not be copied into the workspace: ${miss.reason}. The agent won't be able to see it.`, "error");
    }
  }

  let tokenUpdateTimeout: ReturnType<typeof setTimeout> | null = null;
  const onTokenUpdate = (inputTokens: number, outputTokens: number) => {
    if (tokenUpdateTimeout) clearTimeout(tokenUpdateTimeout);
    tokenUpdateTimeout = setTimeout(() => {
      const liveCost = calculateCost(liveEffectiveModel, providerMode, inputTokens, outputTokens)
        ?? (providerMode === "cli" ? estimateCostForCli(liveEffectiveModel, inputTokens, outputTokens) : null);
      prisma.task.update({
        where: { id: taskId },
        data: { inputTokens, outputTokens, ...(liveCost !== null ? { estimatedCost: liveCost } : {}) },
      }).catch(() => {});
    }, 2000);
  };

  const agentSpan = {
    providerType: providerMode,
    requestModel: liveEffectiveModel || undefined,
    attributes: { "ctm.provider.name": providerName },
  };
  // GenAI backends name a run (a trace) after its agent, so the agent is the task: a single
  // agent is one `invoke_agent <task title>` span carrying the usage; a team run is an
  // `invoke_agent <task title>` span with no model or usage of its own, whose members are
  // `invoke_agent <member>` sub-agents carrying theirs (see runTeamPipeline).
  const taskAgentName = task.title.trim() || taskId;
  const result: ExecutionResult & { awaitingApproval?: boolean } = await (teamForPipeline
    ? withTaskSpan(taskId, `invoke_agent ${taskAgentName.slice(0, 120)}`, {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": taskAgentName,
        "gen_ai.agent.id": taskId,
        "gen_ai.conversation.id": taskId,
        "gen_ai.provider.name": genAiProviderName(providerMode),
        "ctm.provider.type": providerMode,
        "ctm.provider.name": providerName,
        "ctm.team.name": teamForPipeline.name,
      }, () => runTeamPipeline(
        taskId,
        teamForPipeline,
        promptTask,
        provider,
        getWorkspacePath(taskId),
        isResume,
        priorLogs,
        globalInstructions,
        enableAgentDelegation,
        getNextMessage,
        isCancelled,
        onTokenUpdate,
        [agentTools.promptSection, mcpServers.promptSection, subtasksPrompt].filter(Boolean).join("\n\n"),
        agentSpan,
        parseTeamProgress(task.teamProgress),
      ).then((executed) => {
        const errorType = agentRunErrorType(executed);
        if (errorType) markSpanFailed(executed.error ?? "Team pipeline failed", errorType);
        return executed;
      }))
    : withAgentSpan(taskId, { agentName: taskAgentName, agentId: taskId, ...agentSpan }, () =>
        provider.execute(taskId, prompt, async (chunk: string, level: "info" | "error" | "system" = "info") => {
          await log(taskId, chunk, level);
        }, getNextMessage, getWorkspacePath(taskId), isCancelled, onTokenUpdate))
  ).finally(() => Promise.all([agentTools.cleanup(), mcpServers.cleanup()]));

  if (tokenUpdateTimeout) clearTimeout(tokenUpdateTimeout);

  // After CLI execution, read credentials back from disk and update the DB if they changed.
  // Claude CLI refreshes OAuth tokens automatically and writes the new credentials to disk,
  // so we must sync them back to the DB or the next run will use the stale (expired) token.
  if (providerMode === "cli") {
    try {
      const { homedir } = await import("os");
      const effectiveConfigDir = configDir || path.join(homedir(), ".claude");
      const credFile = path.join(effectiveConfigDir, ".credentials.json");
      // Only adopt a rotation from a config dir this provider owns. In a dir shared with
      // another connection, what's there may be that connection's login, and copying it onto
      // this row would leave two providers permanently pointing at one account.
      if (fs.existsSync(credFile) && canAdoptDiskCredentials(effectiveConfigDir, resolvedAIProvider.id)) {
        const freshCreds = fs.readFileSync(credFile, "utf8").trim();
        if (freshCreds && freshCreds !== (resolvedAIProvider.credentialsJson ?? "").trim()) {
          await prisma.aIProvider.update({
            where: { id: resolvedAIProvider.id },
            data: { credentialsJson: freshCreds },
          });
          await log(taskId, "CLI credentials refreshed and saved to DB.", "system");
        }
      }
    } catch (err) {
      await log(taskId, `Warning: failed to sync refreshed credentials to DB: ${err instanceof Error ? err.message : String(err)}`, "system");
    }
  }

  // Codex may refresh its login while running. Keep the database copy in sync so a
  // container restart does not discard the refreshed native auth.json.
  if (providerMode === "codex-cli") {
    try {
      const authFile = codexAuthFile(configDir);
      // Same ownership rule as the Claude CLI sync-back above.
      if (fs.existsSync(authFile) && canAdoptDiskCredentials(resolveCodexHome(configDir), resolvedAIProvider.id)) {
        const freshAuth = fs.readFileSync(authFile, "utf8").trim();
        if (freshAuth && freshAuth !== (resolvedAIProvider.credentialsJson ?? "").trim()) {
          await prisma.aIProvider.update({ where: { id: resolvedAIProvider.id }, data: { credentialsJson: freshAuth } });
          await log(taskId, "Codex CLI auth.json refreshed and saved to DB.", "system");
        }
      }
    } catch (err) { await log(taskId, `Warning: failed to sync Codex auth.json: ${err instanceof Error ? err.message : String(err)}`, "system"); }
  }

  const computeCost = (model: string, mode: string, inp: number, out: number): number | null => {
    const real = calculateCost(model, mode, inp, out);
    if (real !== null) return real;
    if (mode === "cli") return estimateCostForCli(model, inp, out);
    return null;
  };

  const current = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
  if (current?.status === "killed" || current?.status === "failed") {
    // Still save token usage even if killed
    if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
      const inputTokens = result.inputTokens ?? 0;
      const outputTokens = result.outputTokens ?? 0;
      const estimatedCost = computeCost(liveEffectiveModel, providerMode, inputTokens, outputTokens);
      await prisma.task.update({
        where: { id: taskId },
        data: {
          inputTokens,
          outputTokens,
          ...(estimatedCost !== null ? { estimatedCost } : {}),
        },
      });
      if (inputTokens > 0 || outputTokens > 0) {
        await log(taskId, `Tokens used: input ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}${estimatedCost !== null ? ` | Est. cost: $${estimatedCost.toFixed(5)}` : ""}`, "system");
      }
    }
    return;
  }

  // Save token usage regardless of result
  if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
    const inputTokens = result.inputTokens ?? 0;
    const outputTokens = result.outputTokens ?? 0;
    const estimatedCost = computeCost(liveEffectiveModel, providerMode, inputTokens, outputTokens);
    await prisma.task.update({
      where: { id: taskId },
      data: {
        inputTokens,
        outputTokens,
        ...(estimatedCost !== null ? { estimatedCost } : {}),
      },
    });
    if (inputTokens > 0 || outputTokens > 0) {
      await log(taskId, `Tokens used: input ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}${estimatedCost !== null ? ` | Est. cost: $${estimatedCost.toFixed(5)}` : ""}`, "system");
    }
  }

  // A team member that needs manual approval just finished: park the task until a human
  // approves its output (or asks for a revision) on the task page. Nothing is committed or
  // pushed yet — the workspace is kept as-is and the next run (re-queued by the approval,
  // with retryCount bumped so it reuses this workspace) carries on from the next member.
  if (result.awaitingApproval) {
    authFailedProvidersByTask.delete(taskId);
    if (resolvedAIProvider.throttledUntil) {
      await prisma.aIProvider.update({ where: { id: resolvedAIProvider.id }, data: { throttledUntil: null } });
    }
    try {
      fs.rmSync(path.join(getWorkspacePath(taskId), ".task-state.md"), { force: true });
    } catch { /* best effort */ }
    await prisma.task.update({ where: { id: taskId }, data: { status: AWAITING_APPROVAL_STATUS, nextRetryAt: null } });
    await log(taskId, "Task is waiting for manual approval before the team pipeline continues.", "system");
    return;
  }

  // The provider's login is dead ("Failed to authenticate: OAuth session expired and could not
  // be refreshed", a revoked API key, …). That's not the task's fault and retrying on the same
  // connection can't fix it, so hand the task — and whatever work is already in its workspace —
  // to another enabled provider and resume from there. Returns false when there's nobody to
  // hand it to, in which case the task falls through to the ordinary failure path.
  async function handOffAfterAuthFailure(): Promise<boolean> {
    const provider = resolvedAIProvider!;
    const failed = authFailedProvidersByTask.get(taskId) ?? new Set<string>();
    failed.add(provider.id);
    authFailedProvidersByTask.set(taskId, failed);

    await log(taskId, `Provider "${providerName}" could not authenticate: ${result.error ?? "credentials expired"}. Its credentials need to be re-entered in Settings → AI Providers.`, "error");
    recordProviderAuthFailure({
      provider: { id: provider.id, name: provider.name, type: provider.type },
      source: "task_run",
      reason: result.error ?? "Credentials expired",
      taskId,
    });
    await notifyProviderAuthFailure(provider, result.error ?? "Credentials expired");

    if (!autoSwitch) {
      await log(taskId, "Automatic provider switching is turned off, so the task can't move to another provider.", "system");
      return false;
    }

    const altProvider = await findAlternateProvider([...failed]);
    if (!altProvider) {
      await log(taskId, "No other enabled, un-throttled provider is available to continue this task.", "system");
      return false;
    }

    await log(taskId, `Switching to "${altProvider.name}" and continuing the task from where it left off.`, "system");
    await writeTaskStateFile(taskId, task!.title, task!.repos, `Provider "${providerName}" failed to authenticate — switching to ${altProvider.name}`);
    await prisma.task.update({
      where: { id: taskId },
      data: {
        aiProviderId: altProvider.id,
        status: "pending",
        retryCount: { increment: 1 },
        nextRetryAt: null,
      },
    });
    return true;
  }

  if (result.success || result.budgetExceeded) {
    authFailedProvidersByTask.delete(taskId);
    // Clear any stale throttle flag — provider is working again
    if (resolvedAIProvider.throttledUntil) {
      await prisma.aIProvider.update({
        where: { id: resolvedAIProvider.id },
        data: { throttledUntil: null },
      });
    }

    // The task-state file describes an *interruption*, and buildPrompt() prefers it
    // over fresh logs. This run finished, so anything still on disk is from an older
    // attempt — drop it, or a later resume (manual retry, review iteration) gets fed
    // a stale "you were interrupted doing X" snapshot. The verification ledger is
    // deliberately kept: it's fingerprinted against the working tree, so it stays
    // valid across runs and expires itself when the source changes.
    try {
      fs.rmSync(path.join(getWorkspacePath(taskId), ".task-state.md"), { force: true });
    } catch { /* best effort */ }

    if (result.budgetExceeded) {
      const used = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
      if (task.costBudget) {
        const actualCost = computeCost(liveEffectiveModel, providerMode, result.inputTokens ?? 0, result.outputTokens ?? 0) ?? 0;
        await log(taskId, `Cost budget reached ($${actualCost.toFixed(4)} spent / $${task.costBudget.toFixed(2)} budget). Committing work completed so far.`, "system");
      } else {
        await log(taskId, `Token budget reached (${used.toLocaleString()} / ${task.tokenBudget?.toLocaleString()} tokens used). Committing work completed so far.`, "system");
      }
    }
    // Grab the last AI info log now — this is the same "result" summary shown on the task
    // detail page (see src/app/tasks/[id]/page.tsx) once the task is terminal. Computed here,
    // before any git/PR work below, since none of that work adds further "info"-level logs.
    const lastAILogEarly = await prisma.taskLog.findFirst({
      where: { taskId, level: "info" },
      orderBy: { createdAt: "desc" },
    });
    const lastAIMessage = lastAILogEarly?.content?.trim() || undefined;
    // Same message, but with any "## Test Plan" section it contains stripped out — that
    // section is already surfaced separately (via extractTestPlan below) in the PR body,
    // so keep the "## Result" section from duplicating it.
    const resultForPR = lastAIMessage
      ?.replace(/##\s*Test Plan\s*\n[\s\S]*?(?=\n##\s|$)/i, "")
      .trim() || undefined;

    if (isFileOutput) {
      // Scan the output/ directory for any produced files and persist them as File records
      const outputDir = path.join(getWorkspacePath(taskId), "output");
      if (fs.existsSync(outputDir)) {
        const outputFiles = fs
          .readdirSync(outputDir, { withFileTypes: true })
          .filter((d) => d.isFile() && !d.name.startsWith("."))
          .map((d) => d.name);
        if (outputFiles.length === 0) {
          await log(taskId, "No output files found in output/ directory.", "system");
        } else {
          // Group every file this task produces into a single folder (named after the
          // task) instead of dropping them loose at the top level of /files — this keeps
          // the file browser organized as tasks accumulate output over time. Reuse an
          // existing folder on retries rather than creating a duplicate.
          let folder = await prisma.file.findFirst({
            where: { taskId, isFolder: true, parentId: null },
          });
          if (!folder) {
            const folderName = task.title.trim().slice(0, 100) || "Output";
            folder = await prisma.file.create({
              data: { taskId, name: folderName, isFolder: true },
            });
          }
          for (const outputFile of outputFiles) {
            try {
              const content = fs.readFileSync(path.join(outputDir, outputFile), "utf8");
              // Keep the full filename including its extension so the UI can detect the file type
              const name = outputFile;
              await prisma.file.create({ data: { taskId, parentId: folder.id, name, content } });
              await log(taskId, `Saved file: ${outputFile}`, "system");
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              await log(taskId, `Failed to save file ${outputFile}: ${msg}`, "error");
              hasErrors = true;
            }
          }
        }
      } else {
        await log(taskId, "Output directory not found, no files were produced.", "system");
      }
    } else if (!isReadOnly && task.repos.length > 0) {
      const gitCreds = await loadGitCredentials();
      const commitShaMap: Record<string, string> = {};
      // Repo alias -> PR info, for every PR created below. A multi-repo task creates one
      // PR per repo, so this map (persisted to task.prUrls) is what PR-merge sync must
      // check in full — task.prUrl/prNumber below only ever mirror the *first* PR created,
      // kept for backward compatibility with the single-PR UI affordances.
      const prUrlsMap: Record<string, { url: string; number: number }> = {};
      // Tracks whether *any* repo had actual changes to commit. If every repo the
      // agent touched came back clean, there's nothing to review/merge — the task
      // is reported as "no_changes" instead of "completed" (see status update below)
      // so it isn't confused with a PR-creation failure.
      let anyRepoHadChanges = false;

      // Extract the test plan now (Claude has finished running) so we can include it in the PR body
      const infoLogsForPR = await prisma.taskLog.findMany({
        where: { taskId, level: "info" },
        orderBy: { createdAt: "asc" },
        select: { content: true },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prTestPlan = extractTestPlan(infoLogsForPR.map((l: any) => l.content).join("\n"));
      for (const repo of task.repos) {
        try {
          const { simpleGit } = await import("simple-git");
          const repoDest = getRepoDest(taskId, repo.alias);
          const git = simpleGit(repoDest).env(safeEnv());
          // If the task was configured to start from a specific source branch, PRs should
          // target that branch instead of the global default — otherwise fall back to it.
          const repoBranch = (repo as { branch?: string | null }).branch || undefined;

          // Verify Claude left the repo on the expected branch. Claude has full git
          // access during execution and may have switched branches. Correct before commit.
          const branchStatus = await git.branch();
          const currentBranch = branchStatus.current;
          if (currentBranch !== branch) {
            await log(taskId, `Branch mismatch: agent worked on '${currentBranch}', expected '${branch}'. Correcting...`, "system");
            if (!workOnExistingBranch) {
              // Agent branch: force-create/reset the expected branch at current HEAD and switch
              // to it. Plain `git branch` fails if the branch already exists locally, which
              // happens whenever the agent branch was created during workspace setup and Claude
              // then checked out a different branch name of its own choosing.
              await git.checkout(["-B", branch]);
            } else {
              // Target branch: merge current branch's commits into the target before pushing
              const mergeSource = currentBranch;
              await git.fetch("origin");
              await git.checkout(branch);
              const remoteRef = await git.raw(["ls-remote", "--heads", "origin", branch]).catch(() => "");
              if (remoteRef.trim()) {
                await git.pull("origin", branch, ["--rebase", "-X", "theirs"]);
              }
              await git.merge([mergeSource]);
            }
          }

          const commitMsg = result.budgetExceeded
            ? `agent: partial task "${task.title}" (token budget reached)`
            : `agent: complete task "${task.title}"`;
          const { sha: commitSha, hadChanges: dirtyTreeHadChanges } = await commitAll(git, commitMsg, gitCreds);
          // commitAll only catches changes still sitting uncommitted in the working tree at
          // this point. If the agent already committed its own work mid-run (the normal case —
          // see the baseline snapshot above), the tree is clean here and commitAll reports
          // false even though the branch has moved. Compare the resulting HEAD against the
          // pre-run baseline to catch that case too; either signal being true means this repo
          // has real commits to push/PR.
          const headAfterCommit = (commitSha || (await git.revparse(["HEAD"]).catch(() => "")).trim() || undefined);
          const baseSha = baseHeadShaMap[repo.alias];
          const hadChanges = resolveRepoHadChanges(dirtyTreeHadChanges, baseSha, headAfterCommit);
          // Only record the sha when something was actually committed this run (either just
          // now, or earlier by the agent) — falling back to a pre-existing HEAD sha here would
          // point at unrelated prior history and mask the fact that this run made no changes.
          if (headAfterCommit && hadChanges) {
            commitShaMap[repo.alias] = headAfterCommit;
          }
          if (hadChanges) anyRepoHadChanges = true;
          const pushTarget = branch; // already resolved above (targetBranch / main / agent branch)
          await pushBranch(repoDest, pushTarget, gitCreds, workOnExistingBranch);
          // Don't take the push's word for it — confirm origin actually has this HEAD.
          // Throws into the catch below (hasErrors) so a task whose work never reached
          // the remote can't be reported as completed.
          const pushedSha = await verifyBranchPushed(repoDest, pushTarget, gitCreds);
          await log(taskId, `Pushed ${repo.alias} to ${pushTarget} (${pushedSha.slice(0, 7)})`, "system");
          const prSummary = await generatePRSummary(task.title, pushTarget, !!task.createPR && !workOnExistingBranch);
          await prisma.task.update({ where: { id: taskId }, data: { prSummary } });

          const providerSettings = await loadGitProviderSettings();
          const configuredBase = repoBranch || providerSettings.defaultBaseBranch;
          const prBaseBranch = await resolveBaseBranch(git, configuredBase);
          if (prBaseBranch !== configuredBase) {
            await log(taskId, `Base branch '${configuredBase}' doesn't exist on ${repo.alias}'s origin, using its default branch '${prBaseBranch}' instead.`, "system");
          }
          // Compare against the PR base too, not just this run's baseline: a retry of a
          // task whose earlier run pushed but never opened its PR has no *new* commits,
          // yet still needs that PR.
          const commitsAheadOfBase = task.createPR && !workOnExistingBranch
            ? await countCommitsAheadOfBase(git, prBaseBranch)
            : null;
          const prDecision = decidePrAction({
            createPR: !!task.createPR,
            workOnExistingBranch: !!workOnExistingBranch,
            hasToken: !!gitCreds.token,
            hadChanges,
            commitsAheadOfBase,
          });

          if (prDecision.action === "no_changes" || (!hadChanges && prDecision.action === "skip")) {
            // GitHub/GitLab reject PR/MR creation with a "no commits between branches"
            // error when the branch is identical to base — trying anyway just produces
            // a confusing "PR creation failed" state for a run that didn't actually fail.
            await log(taskId, `No changes to commit for ${repo.alias}, skipping PR creation.`, "system");
          } else if (prDecision.action === "error") {
            await log(taskId, `PR required for ${repo.alias} but not created: ${prDecision.reason}`, "error");
            await prisma.task.update({ where: { id: taskId }, data: { prError: prDecision.reason } });
            hasErrors = true;
          } else if (prDecision.action === "create") {
            // The branch carries work for review even if this particular run added no
            // new commits (see commitsAheadOfBase above) — it must not end as no_changes.
            anyRepoHadChanges = true;
            const detectedProvider = detectProvider(repo.url);
            const effectiveProvider = detectedProvider !== "other" ? detectedProvider : providerSettings.provider;
            const baseUrl = providerSettings.baseUrl || "https://gitlab.com";
            const token = gitCreds.token as string;
            const findExisting = () => effectiveProvider === "github"
              ? findOpenGitHubPR({ repoUrl: repo.url, branch, token })
              : findOpenGitLabMR({ repoUrl: repo.url, branch, token, baseUrl });
            try {
              const prBody = [
                `This PR was created automatically by Claude Task Manager.\n\nTask: ${task.title}\n\n${task.description}`,
                resultForPR ? `## Result\n\n${resultForPR}` : "",
                prTestPlan ? `## Test Plan\n\n${prTestPlan}` : "",
              ].filter(Boolean).join("\n\n");

              // Adopt an already-open PR for this branch (a retry, or the agent opened
              // one itself) — creating another would fail with "already exists".
              let pr = await findExisting().catch(() => null);
              let adopted = !!pr;
              if (!pr) {
                try {
                  pr = effectiveProvider === "github"
                    ? await createGitHubPR({ repoUrl: repo.url, branch, title: task.title, body: prBody, token, base: prBaseBranch })
                    : await createGitLabMR({ repoUrl: repo.url, branch, title: task.title, body: prBody, token, baseUrl, base: prBaseBranch });
                } catch (createErr) {
                  // Lost a race with another creator — fall back to whatever is open now.
                  pr = await findExisting().catch(() => null);
                  if (!pr) throw createErr;
                  adopted = true;
                }
              }
              prUrlsMap[repo.alias] = { url: pr.url, number: pr.number };
              await prisma.task.update({
                where: { id: taskId },
                data: {
                  prUrls: JSON.stringify(prUrlsMap),
                  prError: null,
                  // Only mirror into the legacy single-PR fields the first time — later
                  // repos in this loop must not clobber the first PR's url/number.
                  ...(Object.keys(prUrlsMap).length === 1 ? { prUrl: pr.url, prNumber: pr.number } : {}),
                },
              });
              await log(taskId, adopted ? `Using existing PR: ${pr.url}` : `PR created: ${pr.url}`, "system");
            } catch (prErr: unknown) {
              const msg = prErr instanceof Error ? prErr.message : String(prErr);
              // A PR was explicitly requested and the branch has work — failing to open
              // it is a task failure, not a footnote on a "completed" task. The retry
              // picks the pushed branch back up and opens the PR then.
              await log(taskId, `PR creation failed for ${repo.alias}: ${msg}`, "error");
              await prisma.task.update({ where: { id: taskId }, data: { prError: msg } });
              hasErrors = true;
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await log(taskId, `Git push error for ${repo.alias}: ${msg}`, "error");
          hasErrors = true;
        }
      }
      // Persist commit SHAs so the UI can link to them
      if (Object.keys(commitShaMap).length > 0) {
        await prisma.task.update({
          where: { id: taskId },
          data: { commitSha: JSON.stringify(commitShaMap) },
        });
      }
      noChangesOnly = !hasErrors && !anyRepoHadChanges;
    }
    // "Review PR" follow-up: the task was re-run on its existing branch specifically to
    // review its own PR (see src/app/api/tasks/[id]/review-pr/route.ts), and the prompt
    // asked the agent to end with a message written as a standalone review comment. Post
    // that final message to every PR this task is attached to so the round-trip lands
    // back in GitHub/GitLab without the user copying anything manually.
    if (!hasErrors && !isReadOnly && task.repos.length > 0 && isReviewPr && lastAIMessage) {
      try {
        const gitCreds = await loadGitCredentials();
        if (gitCreds.token) {
          const providerSettings = await loadGitProviderSettings();
          const prMap = parsePRUrls(task.prUrls);
          if (Object.keys(prMap).length === 0 && task.prUrl && task.prNumber) {
            const alias = task.repos[0]?.alias;
            if (alias) prMap[alias] = { url: task.prUrl, number: task.prNumber };
          }
          for (const [alias, info] of Object.entries(prMap)) {
            const repo = task.repos.find((r: { alias: string; url: string }) => r.alias === alias);
            if (!repo) continue;
            try {
              const detectedProvider = detectProvider(repo.url);
              const effectiveProvider = detectedProvider !== "other" ? detectedProvider : providerSettings.provider;
              if (effectiveProvider === "github") {
                await createGitHubPRComment({ repoUrl: repo.url, number: info.number, body: lastAIMessage, token: gitCreds.token });
              } else {
                const baseUrl = providerSettings.baseUrl || "https://gitlab.com";
                await createGitLabMRComment({ repoUrl: repo.url, number: info.number, body: lastAIMessage, token: gitCreds.token, baseUrl });
              }
              await log(taskId, `Posted review comment on PR: ${info.url}`, "system");
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              await log(taskId, `Failed to post review comment for ${alias}: ${msg}`, "error");
            }
          }
        } else {
          await log(taskId, "Skipped posting review comment, no git access token configured.", "system");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(taskId, `Review comment step failed: ${msg}`, "error");
      }
    }

    // Neutralize the review-request section in the persisted context once this review
    // run has finished (successfully or not) so a later, unrelated retry doesn't silently
    // re-enter "review PR" mode (overridden description + auto-posting another comment).
    // Clicking "Review PR" again builds a fresh section from scratch, so this is safe.
    if (isReviewPr && task.context) {
      const sectionRegex = new RegExp(`${REVIEW_PR_MARKER}[\\s\\S]*?(?=\\n##\\s|$)`);
      const neutralized = task.context.replace(sectionRegex, `${REVIEW_PR_MARKER}\n_(Reviewed: see PR comment for this task's review notes.)_`);
      if (neutralized !== task.context) {
        await prisma.task.update({ where: { id: taskId }, data: { context: neutralized } });
      }
    }

    // A "fix merge conflict" run just finished (successfully or not) — re-check this
    // task's PR mergeability/CI status right away instead of leaving the card showing
    // the stale "conflicting" chip until the next periodic poll or a manual Refresh
    // click. Non-fatal: if the check fails, the existing periodic sync / manual
    // Refresh still catches it eventually.
    //
    // This must happen BEFORE the task's status is flipped to a terminal value below.
    // The kanban board only polls /api/tasks on an interval while at least one task is
    // in an active status (pending/running/paused/throttled) — the instant this task's
    // status lands as "completed"/"failed", the frontend's poll loop stops. If the
    // mergeableState refresh happened after that status write (as it used to), the
    // board would have already stopped polling by the time the fresh mergeableState
    // landed, so the conflict badge would stay stuck showing "conflicting" until a
    // manual refresh or page reload. Doing it first means the status flip the frontend
    // observes always carries the up-to-date mergeableState alongside it.
    if (isRebaseOnly) {
      try {
        await syncTaskPRStatuses(prisma, { taskId });
      } catch (err) {
        console.error("Post-rebase PR status sync error (non-fatal):", err);
      }
    }

    if (!hasErrors) {
      const infoLogs = await prisma.taskLog.findMany({
        where: { taskId, level: "info" },
        orderBy: { createdAt: "asc" },
        select: { content: true },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const testPlan = extractTestPlan(infoLogs.map((l: any) => l.content).join("\n"));
      await prisma.task.update({
        where: { id: taskId },
        data: {
          ...(testPlan ? { testPlan } : {}),
          // No point putting a no-op run "in review" — there's no diff/PR to review.
          ...(!isReadOnly && task.repos.length > 0 && !noChangesOnly ? { reviewStatus: "in_review" } : {}),
          // A retried task keeps the reviewStatus its earlier run left behind. If this
          // run made no changes and there's no PR open, clear a stale "in_review" so the
          // card doesn't sit in In Review with nothing to look at (see columnFor()).
          ...(noChangesOnly && task.reviewStatus === "in_review" && !task.prUrl && Object.keys(parsePRUrls(task.prUrls)).length === 0
            ? { reviewStatus: null }
            : {}),
        },
      });
    }

    if (hasErrors) {
      await prisma.task.update({ where: { id: taskId }, data: { status: "failed" } });
      await log(taskId, "Task failed due to errors.", "error");
      try {
        const notif = await getNotificationSettings(prisma);
        const appHost = await getAppHost(prisma);
        const freshTask = await prisma.task.findUnique({ where: { id: taskId } });
        const notifResult = await sendTaskNotification(notif, "failed", { ...(freshTask ?? task), provider: providerName }, lastAIMessage, appHost);
        if (notifResult.sent) {
          await log(taskId, `Notification sent to ${notif.emailAddress}`, "system");
        } else {
          await log(taskId, `Notification skipped: ${notifResult.reason}`, "system");
        }
        await notifyEmailSourceIfPresent(taskId, freshTask?.sourceEmail, "failed", { ...(freshTask ?? task) }, providerName, lastAIMessage, appHost);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(taskId, `Notification error: ${msg}`, "system");
        console.error("Notification error (non-fatal):", err);
      }
    } else {
      const finalStatus = noChangesOnly ? "no_changes" : "completed";
      await prisma.task.update({ where: { id: taskId }, data: { status: finalStatus } });
      if (noChangesOnly) {
        await log(
          taskId,
          isReviewPr
            ? "No changes requested. Review found nothing to fix. The pull request is still open."
            : "Task finished with no code changes, nothing to commit or open a PR for.",
          "system",
        );
      } else if (isReviewPr) {
        await log(taskId, "Changes requested: review made revisions and pushed them to the pull request.", "system");
      } else {
        await log(taskId, "Task completed successfully.", "system");
      }

      // Turn any subtasks the agent asked for into real tasks.
      if (task.allowSubtasks && !isRebaseOnly && !isReviewPr) {
        await createRequestedSubtasks(task);
      }

      // Spawn a follow-up validation task if requested
      if (task.createValidationTask) {
        try {
          const maxPos2 = await prisma.task.aggregate({ _max: { position: true } });
          const validationContext = [
            `You are a validation agent. Your job is to verify that the following task was completed correctly.`,
            ``,
            `## Original Task`,
            `**Title:** ${task.title}`,
            `**Description:** ${task.description}`,
            task.context ? `**Additional Instructions:** ${task.context}` : null,
            ``,
            `## Your Validation Steps`,
            `1. Review the work done by the previous agent (check the repository, files changed, output produced).`,
            `2. Verify it matches the original task description and expected outcome.`,
            `3. Identify any issues, missing steps, or errors.`,
            `4. If validation passes, print a clear success summary.`,
            `5. If validation fails, describe exactly what is wrong and what changes are needed to fix it. Output the marker \`---TASK_COMPLETE---\` at the end only when you have finished your validation report.`,
          ].filter((l) => l !== null).join("\n");

          const validationTask = await prisma.task.create({
            data: {
              title: `Validate: ${task.title}`,
              description: `Validate that the task "${task.title}" was completed successfully and meets the requirements.`,
              context: validationContext,
              provider: task.provider,
              model: task.model,
              pushToMain: false,
              targetBranch: null,
              createPR: false,
              position: (maxPos2._max.position ?? -1) + 1,
              priority: task.priority,
              effort: task.effort,
              toolAccess: task.toolAccess ?? null,
              aiProviderId: task.aiProviderId || null,
              useSmartProvider: Boolean(task.useSmartProvider),
              dependsOnTaskId: taskId,
              repos: {
                create: task.repos.map((r: { alias: string; url: string; branch?: string | null }) => ({
                  alias: r.alias,
                  url: r.url,
                  branch: r.branch || null,
                })),
              },
            },
          });
          await log(taskId, `Validation task created: ${validationTask.id} ("${validationTask.title}")`, "system");
        } catch (validationErr) {
          const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
          await log(taskId, `Warning: failed to create validation task: ${msg}`, "system");
          console.error("Validation task creation error (non-fatal):", validationErr);
        }
      }

      try {
        const notif = await getNotificationSettings(prisma);
        const appHost = await getAppHost(prisma);
        const freshTask = await prisma.task.findUnique({ where: { id: taskId } });
        const notifResult = await sendTaskNotification(notif, "completed", { ...(freshTask ?? task), provider: providerName }, lastAIMessage, appHost);
        if (notifResult.sent) {
          await log(taskId, `Notification sent to ${notif.emailAddress}`, "system");
        } else {
          await log(taskId, `Notification skipped: ${notifResult.reason}`, "system");
        }
        await notifyEmailSourceIfPresent(taskId, freshTask?.sourceEmail, "completed", { ...(freshTask ?? task) }, providerName, lastAIMessage, appHost);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(taskId, `Notification error: ${msg}`, "system");
        console.error("Notification error (non-fatal):", err);
      }
    }
  } else if (result.shouldRetry) {
    const throttledUntil = result.retryAfter ?? new Date(Date.now() + 3600000);

    // Record when this provider's limit resets
    await prisma.aIProvider.update({
      where: { id: resolvedAIProvider.id },
      data: { throttledUntil },
    });

    if (autoSwitch) {
      const altProvider = await findAlternateProvider(resolvedAIProvider.id);

      if (altProvider) {
        await log(taskId, `Provider "${providerName}" is throttled (resets ${throttledUntil.toISOString()}). Auto-switching to "${altProvider.name}".`, "system");
        await writeTaskStateFile(taskId, task.title, task.repos, `Rate limited — switching to ${altProvider.name}`);
        await prisma.task.update({
          where: { id: taskId },
          data: {
            aiProviderId: altProvider.id,
            status: "pending",
            retryCount: { increment: 1 },
            nextRetryAt: null,
          },
        });
        return;
      }

      // All providers are throttled — schedule with whichever resets soonest
      const soonestProvider = await findSoonestThrottledProvider();

      if (soonestProvider?.throttledUntil) {
        await log(taskId, `All providers are throttled. Scheduling to use "${soonestProvider.name}" at ${soonestProvider.throttledUntil.toISOString()}.`, "system");
        await writeTaskStateFile(taskId, task.title, task.repos, "All providers throttled");
        await prisma.task.update({
          where: { id: taskId },
          data: {
            aiProviderId: soonestProvider.id,
            status: "throttled",
            retryCount: { increment: 1 },
            nextRetryAt: soonestProvider.throttledUntil,
          },
        });
        await log(taskId, `Task paused. Will retry at ${soonestProvider.throttledUntil.toISOString()} with "${soonestProvider.name}".`, "system");
        return;
      }
    }

    // Auto-switch disabled (or no alternate found without auto-switch) — retry with same provider
    await writeTaskStateFile(taskId, task.title, task.repos, "Rate limited / throttled by API");
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: "throttled",
        retryCount: { increment: 1 },
        nextRetryAt: throttledUntil,
      },
    });
    await log(taskId, `Task paused. Will retry at ${throttledUntil.toISOString()}`, "system");
  } else if (result.authFailed && await handOffAfterAuthFailure()) {
    return;
  } else {
    authFailedProvidersByTask.delete(taskId);
    const timedOut = result.error === "Task timed out";
    const stopReason = timedOut ? "Task timed out" : `Task failed: ${result.error ?? "unknown error"}`;
    await writeTaskStateFile(taskId, task.title, task.repos, stopReason);

    // Check if auto-retry on failure is enabled and we haven't exceeded the limit
    // Note: task.retryCount tracks all retries (including rate-limit ones). We use a
    // separate counter stored in the task state so auto-failure-retries don't stack
    // on top of rate-limit retries. For simplicity we use retryCount here — the setting
    // is a cap on total attempts, which is the most user-expected behaviour.
    const autoRetrySetting = await prisma.setting.findUnique({ where: { key: "max_auto_retries" } });
    const maxAutoRetries = autoRetrySetting?.value ? parseInt(autoRetrySetting.value, 10) : 0;
    const autoRetryEnabled = !isNaN(maxAutoRetries) && maxAutoRetries > 0 && !timedOut;
    const autoRetryExhausted = task.retryCount >= maxAutoRetries;

    if (autoRetryEnabled && !autoRetryExhausted) {
      await log(taskId, `Task failed (attempt ${task.retryCount + 1}/${maxAutoRetries + 1}): ${result.error ?? "unknown error"}. Auto-retrying…`, "system");
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: "pending",
          retryCount: { increment: 1 },
        },
      });
      return;
    }

    await prisma.task.update({
      where: { id: taskId },
      data: { status: timedOut ? "timedout" : "failed" },
    });
    if (!timedOut) {
      await log(taskId, `Task failed: ${result.error ?? "unknown error"}`, "error");
      try {
        const lastAILog2 = await prisma.taskLog.findFirst({
          where: { taskId, level: "info" },
          orderBy: { createdAt: "desc" },
        });
        const notif = await getNotificationSettings(prisma);
        const appHost = await getAppHost(prisma);
        const freshTask = await prisma.task.findUnique({ where: { id: taskId } });
        const notifResult = await sendTaskNotification(notif, "failed", { ...(freshTask ?? task), provider: providerName }, lastAILog2?.content?.trim() || undefined, appHost);
        if (notifResult.sent) {
          await log(taskId, `Notification sent to ${notif.emailAddress}`, "system");
        } else {
          await log(taskId, `Notification skipped: ${notifResult.reason}`, "system");
        }
        await notifyEmailSourceIfPresent(taskId, freshTask?.sourceEmail, "failed", { ...(freshTask ?? task) }, providerName, lastAILog2?.content?.trim() || undefined, appHost);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(taskId, `Notification error: ${msg}`, "system");
        console.error("Notification error (non-fatal):", err);
      }
    }
  }
}

const AUTH_FAILURE_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Providers each task has already failed to authenticate with during this worker's lifetime,
// so a hand-off after a dead login never bounces back to a connection that just failed.
const authFailedProvidersByTask = new Map<string, Set<string>>();

// Tell the user a connection's login is dead — at most once per cooldown, like the periodic
// credential check does, so a burst of tasks hitting the same provider sends one email.
async function notifyProviderAuthFailure(
  provider: { id: string; name: string; authFailureNotifiedAt?: Date | null },
  detail: string,
): Promise<void> {
  const fresh = await prisma.aIProvider.findUnique({ where: { id: provider.id }, select: { authFailureNotifiedAt: true } }).catch(() => null);
  const lastNotified = (fresh?.authFailureNotifiedAt ?? provider.authFailureNotifiedAt)?.getTime() ?? 0;
  if (Date.now() - lastNotified < AUTH_FAILURE_NOTIFY_COOLDOWN_MS) return;
  try {
    const notif = await getNotificationSettings(prisma);
    const appHost = await getAppHost(prisma);
    await sendProviderAuthFailureNotification(notif, provider.name, detail, appHost);
    await prisma.aIProvider.update({ where: { id: provider.id }, data: { authFailureNotifiedAt: new Date() } });
  } catch (err) {
    console.error(`Failed to send auth failure notification for ${provider.name}:`, err);
  }
}

// Proactively record that a provider is out of tokens, using the OAuth usage API's own
// reset time when we have it (falls back to a conservative default otherwise). This is what
// the pre-flight check in runTask() consults before ever cloning a repo or spawning the CLI
// for a task, so a spent subscription throttles new tasks immediately instead of each one
// discovering the outage independently by failing.
async function setProviderThrottledFromUsage(
  providerId: string,
  metrics: ProviderHealthStatus["usageMetrics"],
  fallback?: Date,
  maxUsagePercent: number = 100,
): Promise<void> {
  const throttledUntil = usageResetTime(metrics, maxUsagePercent) ?? fallback ?? new Date(Date.now() + 3600000);
  try {
    await prisma.aIProvider.update({ where: { id: providerId }, data: { throttledUntil } });
  } catch (err) {
    console.error(`Failed to record proactive throttle for provider ${providerId}:`, err);
  }
}

async function refreshCliCredentials(): Promise<void> {
  const { homedir } = await import("os");
  const providers = await prisma.aIProvider.findMany({
    where: { type: "cli", isEnabled: true },
  });

  // A provider currently powering a running task shares its on-disk credentials file with
  // the liveness probe spawned below. Racing an OAuth refresh against the task's own
  // in-flight refresh can burn the rotated refresh token, producing a real-but-misleading
  // "credentials expired" result (and a false auth-failure notification). Skip the probe
  // for those providers — the running task is itself live proof the credentials work.
  const busyProviderIds = new Set(
    (
      await prisma.task.findMany({
        where: { status: "running", aiProviderId: { not: null } },
        select: { aiProviderId: true },
      })
    ).map((t: { aiProviderId: string | null }) => t.aiProviderId!),
  );

  const healthResults: ProviderHealthStatus[] = [];
  const checkedAt = new Date().toISOString();

  // Load existing cache so we can fall back to last-known usage metrics on rate-limit
  const CACHE_KEY = "health_check_results";
  let existingCache: HealthCheckCache = { results: [], checkedAt };
  try {
    const cacheRow = await prisma.setting.findUnique({ where: { key: CACHE_KEY } });
    if (cacheRow?.value) existingCache = JSON.parse(cacheRow.value);
  } catch { /* ignore */ }

  for (const provider of providers) {
    const effectiveConfigDir = provider.configDir?.trim() || path.join(homedir(), ".claude");
    const credFile = path.join(effectiveConfigDir, ".credentials.json");

    // Write DB credentials to disk before running. A concurrent task or health check may have
    // refreshed *this provider's* token, and overwriting that with the stale DB copy would burn
    // the rotated refresh token — but a config dir holding a *different* connection's login is
    // overwritten regardless, or the probe below would run (and report) against the wrong
    // account. See src/lib/providers/cli-credentials.ts.
    if (provider.credentialsJson) {
      try {
        syncCredentialsToDisk({
          providerId: provider.id,
          dir: effectiveConfigDir,
          fileName: ".credentials.json",
          credentialsJson: provider.credentialsJson,
          expiresAtOf: extractExpiresAt,
          otherProviderCredentials: await otherProviderCredentials(provider.id),
        });
      } catch (err) {
        console.error(`Credential refresh: failed to write creds for ${provider.name}:`, err);
        continue;
      }
    }

    if (!fs.existsSync(credFile)) continue;

    // Ask the OAuth usage API first — the liveness prompt below costs tokens, so if the
    // subscription is already spent there is nothing to learn from running it (it can only
    // fail). Skip it and report the usage limit instead of a bogus liveness failure.
    const existingResult = existingCache.results.find((r) => r.providerId === provider.id);
    let preCheckMetrics: ProviderHealthStatus["usageMetrics"] = existingResult?.usageMetrics;
    let preCheckRateLimited: boolean | undefined;
    try {
      const onDiskCreds = fs.readFileSync(credFile, "utf8").trim();
      const preToken = onDiskCreds ? extractOAuthAccessToken(onDiskCreds) : null;
      if (preToken) {
        const preUsage = await fetchOAuthUsage(preToken);
        if (preUsage.metrics) preCheckMetrics = preUsage.metrics;
        else if (preUsage.rateLimited) preCheckRateLimited = true;
      }
    } catch { /* non-fatal — fall through to the live check */ }

    // What the CLI itself will do about usage credits — the account-level flags on the usage
    // payload aren't enough on their own. See readCliExtraUsage().
    const cliExtraUsage = readCliExtraUsage(provider.configDir);

    // Normally a spent window means the probe below can only fail, so we skip it. The exception
    // is the account-says-yes/CLI-says-no disagreement: the CLI's cached gate only refreshes on
    // a real request, so skipping the probe is what would make a stale block permanent. Run it.
    // A provider over its usage cap (`maxUsagePercent`) is held back regardless of credits —
    // the user asked us to leave the rest of the window alone, so there's nothing to probe.
    const overCap = isOverUsageCap(preCheckMetrics, provider.maxUsagePercent);
    if (overCap || (isUsageExhausted(preCheckMetrics, cliExtraUsage.state) && !creditGateMayBeStale(preCheckMetrics, cliExtraUsage))) {
      healthResults.push({
        providerId: provider.id,
        providerName: provider.name,
        providerType: "cli",
        authStatus: "ok",
        livenessStatus: "skipped",
        livenessSkipReason: describeUsageExhaustion(preCheckMetrics, cliExtraUsage, provider.maxUsagePercent),
        usageExhausted: true,
        healthy: false,
        checkedAt,
        usageMetrics: preCheckMetrics,
        usageRateLimited: preCheckRateLimited,
      });
      // Record the provider as throttled *before* any task tries to use it, using the usage
      // API's own reset time. This is what lets the task picker skip/reschedule work up front
      // instead of every pending task discovering the outage independently by failing.
      await setProviderThrottledFromUsage(provider.id, preCheckMetrics, undefined, provider.maxUsagePercent);
      continue;
    }

    if (busyProviderIds.has(provider.id)) {
      healthResults.push({
        providerId: provider.id,
        providerName: provider.name,
        providerType: "cli",
        authStatus: "ok",
        livenessStatus: "skipped",
        livenessSkipReason: "Liveness check skipped: a task is currently running on this provider.",
        healthy: true,
        checkedAt,
        usageMetrics: preCheckMetrics,
        usageRateLimited: preCheckRateLimited,
      });
      continue;
    }

    // Run a minimal claude command to trigger OAuth token refresh + liveness check
    const { exitCode: credCheckCode, output: credCheckOutput } = await new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn(
        "claude",
        ["-p", "OK", "--output-format", "text", "--dangerously-skip-permissions", "--max-turns", "1"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: effectiveConfigDir,
            PATH: [process.env.PATH ?? "", process.env.CLAUDE_PATH].filter(Boolean).join(":"),
          },
        },
      );
      let output = "";
      child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { output += d.toString(); });
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve({ exitCode: null, output }); }, 30000);
      child.on("close", (code: number | null) => { clearTimeout(timer); resolve({ exitCode: code, output }); });
      child.on("error", () => { clearTimeout(timer); resolve({ exitCode: 1, output }); });
    });

    // "Reached max turns (1)" means Claude ran and responded — it's alive.
    // Some CLI versions exit non-zero on max-turns; treat that as a successful liveness check.
    const reachedMaxTurns = /reached max turns/i.test(credCheckOutput);
    const livenessOk = credCheckCode === 0 || reachedMaxTurns;

    // A usage/rate limit in the CLI output isn't a liveness failure — the account simply
    // has no tokens left to answer with. Report it as such instead of "Liveness failed".
    const usageLimitMessage = livenessOk ? null : detectUsageLimit(credCheckOutput);

    if (!livenessOk) {
      const isAuthError = !usageLimitMessage
        && /failed to authenticate|invalid.*credential|401|unauthorized|please log in|authentication failed/i.test(credCheckOutput);
      const msg = usageLimitMessage
        ? `Credential refresh: "${provider.name}" is out of tokens: ${usageLimitMessage}`
        : `Credential refresh: CLI exited with code ${credCheckCode ?? "null"} for "${provider.name}"${isAuthError ? " (credentials have expired and need to be re-entered)" : ""}`;
      console.warn(msg);
      if (isAuthError) {
        recordProviderAuthFailure({
          provider: { id: provider.id, name: provider.name, type: "cli" },
          source: "credential_check",
          reason: credCheckOutput.trim().split("\n").slice(0, 3).join("\n") || msg,
        });
        const lastNotified = provider.authFailureNotifiedAt?.getTime() ?? 0;
        if (Date.now() - lastNotified >= AUTH_FAILURE_NOTIFY_COOLDOWN_MS) {
          try {
            const notif = await getNotificationSettings(prisma);
            const appHost = await getAppHost(prisma);
            const errorSnippet = credCheckOutput.trim().split("\n").slice(0, 3).join("\n");
            await sendProviderAuthFailureNotification(notif, provider.name, errorSnippet || msg, appHost);
            await prisma.aIProvider.update({ where: { id: provider.id }, data: { authFailureNotifiedAt: new Date() } });
          } catch (notifErr) {
            console.error("Credential refresh: failed to send auth failure notification:", notifErr);
          }
        }
      } else {
        // Clear the flag once healthy so a future expiry triggers a fresh notification
        if (provider.authFailureNotifiedAt) {
          await prisma.aIProvider.update({ where: { id: provider.id }, data: { authFailureNotifiedAt: null } });
        }
      }
    }

    // Sync refreshed credentials back to DB
    let currentCredsJson: string | null = provider.credentialsJson ?? null;
    try {
      // Ownership-guarded, like every other sync-back: never pull a login out of a config dir
      // that belongs to a different connection.
      if (fs.existsSync(credFile) && canAdoptDiskCredentials(effectiveConfigDir, provider.id)) {
        const freshCreds = fs.readFileSync(credFile, "utf8").trim();
        if (freshCreds && freshCreds !== (provider.credentialsJson ?? "").trim()) {
          await prisma.aIProvider.update({ where: { id: provider.id }, data: { credentialsJson: freshCreds } });
          console.log(`Credential refresh: updated credentials for ${provider.name}`);
          currentCredsJson = freshCreds;
        }
      }
    } catch (err) {
      console.error(`Credential refresh: failed to sync creds for ${provider.name}:`, err);
    }

    // Fetch OAuth usage metrics from the (possibly just-refreshed) token,
    // falling back to the pre-check value / last cached value if the API rate-limits us.
    let usageMetrics: ProviderHealthStatus["usageMetrics"] = preCheckMetrics;
    let usageRateLimited: boolean | undefined = preCheckRateLimited;
    if (currentCredsJson) {
      const token = extractOAuthAccessToken(currentCredsJson);
      if (token) {
        const result = await fetchOAuthUsage(token);
        if (result.metrics) {
          usageMetrics = result.metrics;
          usageRateLimited = undefined;
        } else if (result.rateLimited) {
          usageRateLimited = true;
        }
      }
    }

    // Either the CLI told us we're rate limited, or the usage API says the window is spent.
    const overUsageCap = isOverUsageCap(usageMetrics, provider.maxUsagePercent);
    const outOfTokens = overUsageCap || (!livenessOk && (!!usageLimitMessage || isUsageExhausted(usageMetrics, cliExtraUsage.state)));

    healthResults.push({
      providerId: provider.id,
      providerName: provider.name,
      providerType: "cli",
      authStatus: "ok",
      livenessStatus: livenessOk ? "ok" : (outOfTokens ? "skipped" : "error"),
      livenessError: livenessOk || outOfTokens ? undefined : credCheckOutput.trim().slice(0, 200),
      livenessSkipReason: outOfTokens
        ? (overUsageCap ? describeUsageExhaustion(usageMetrics, cliExtraUsage, provider.maxUsagePercent) : (usageLimitMessage ?? describeUsageExhaustion(usageMetrics, cliExtraUsage)))
        : undefined,
      usageExhausted: outOfTokens ? true : undefined,
      healthy: livenessOk,
      checkedAt,
      usageMetrics,
      usageRateLimited,
    });

    if (outOfTokens) {
      // Same reasoning as the pre-check branch above: mark it throttled now, using the reset
      // time we just learned, so tasks stop trying (and failing) against this provider.
      await setProviderThrottledFromUsage(provider.id, usageMetrics, usageLimitMessage ? new Date(Date.now() + 3600000) : undefined, provider.maxUsagePercent);
    } else if (provider.throttledUntil) {
      // Usage has recovered (or we have no evidence it's still exhausted) — clear a
      // previously-recorded proactive throttle so tasks aren't held back needlessly.
      await prisma.aIProvider.update({ where: { id: provider.id }, data: { throttledUntil: null } }).catch(() => {});
    }
  }

  // Merge CLI results into health check cache, preserving non-CLI provider results
  if (healthResults.length > 0) {
    try {
      const refreshedIds = new Set(healthResults.map((r) => r.providerId));
      const merged: HealthCheckCache = {
        results: [...existingCache.results.filter((r: ProviderHealthStatus) => !refreshedIds.has(r.providerId)), ...healthResults],
        checkedAt,
      };
      await prisma.setting.upsert({
        where: { key: CACHE_KEY },
        create: { key: CACHE_KEY, value: JSON.stringify(merged) },
        update: { value: JSON.stringify(merged) },
      });
    } catch (err) {
      console.error("Credential refresh: failed to update health check cache:", err);
    }
  }
}

async function triggerRecurringTasks() {
  const now = new Date();
  const templates = await prisma.task.findMany({
    where: { isRecurringTemplate: true, isEnabled: true, cronExpression: { not: null } },
    include: { repos: true },
  });
  for (const t of templates) {
    try {
      // Run cap: maxRuns === null means unlimited. Once the template has spawned its
      // allotted number of instances it stays in the list (so the UI can show "5 / 5 runs")
      // but never fires again unless the user raises the cap or resets the counter.
      if (hasReachedRunLimit(t)) continue;
      const interval = CronExpressionParser.parse(t.cronExpression!, {
        currentDate: t.lastScheduledAt ?? t.createdAt,
      });
      const next = interval.next().toDate();
      if (next > now) continue;
      const maxPos = await prisma.task.aggregate({ _max: { position: true } });
      await prisma.task.create({
        data: {
          title: t.title,
          description: t.description,
          context: t.context,
          provider: t.provider,
          model: t.model,
          pushToMain: t.pushToMain,
          targetBranch: t.targetBranch,
          createPR: t.createPR,
          aiProviderId: t.aiProviderId || null,
          useSmartProvider: Boolean(t.useSmartProvider),
          // Carry the template's context-file selection, priority, and effort over to
          // each spawned instance so recurring runs use the same reference files,
          // compete for worker slots, and think at the same depth the template was
          // configured with.
          contextFiles: t.contextFiles,
          priority: t.priority,
          effort: t.effort,
          toolAccess: t.toolAccess ?? null,
          allowSubtasks: Boolean(t.allowSubtasks),
          position: (maxPos._max.position ?? -1) + 1,
          recurringTemplateId: t.id,
          repos: { create: t.repos.map((r: { alias: string; url: string; branch?: string | null }) => ({ alias: r.alias, url: r.url, branch: r.branch || null })) },
        },
      });
      const updated = await prisma.task.update({
        where: { id: t.id },
        data: { lastScheduledAt: now, runCount: { increment: 1 } },
      });
      console.log(
        `Spawned instance for recurring task: ${t.title}` +
          (t.maxRuns != null ? ` (run ${updated.runCount} of ${t.maxRuns})` : "")
      );
      if (t.maxRuns != null && updated.runCount >= t.maxRuns) {
        console.log(`Recurring task "${t.title}" reached its ${t.maxRuns}-run limit and will not run again.`);
      }
    } catch (err) {
      console.error(`Failed to process recurring task ${t.id}:`, err);
    }
  }
}

async function syncPRStatuses(): Promise<void> {
  const syncSetting = await prisma.setting.findUnique({ where: { key: "git_pr_status_sync_enabled" } });
  if (syncSetting?.value !== "true") return;

  // Delegates to the shared helper (also used by the manual "Sync PR status" API route) so
  // multi-repo tasks — which create one PR per repo — only move to Done once every one of
  // their PRs is merged, instead of as soon as a single (possibly mismatched) PR looks merged.
  await syncTaskPRStatuses(prisma);
}

async function getTasksStartedInLastHour(): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 3600000);
  const rows = await prisma.taskLog.findMany({
    where: {
      content: { startsWith: "Starting task:" },
      level: "system",
      createdAt: { gte: oneHourAgo },
    },
    select: { taskId: true },
    distinct: ["taskId"],
  });
  return rows.length;
}

async function recoverInterruptedTasks() {
  const interrupted = await prisma.task.findMany({
    where: { status: "running", isRecurringTemplate: false },
    select: { id: true, title: true, repos: true },
  });
  if (interrupted.length === 0) return;
  console.log(`Recovering ${interrupted.length} interrupted task(s) from previous run...`);
  for (const t of interrupted) {
    await writeTaskStateFile(t.id, t.title, t.repos, "Worker process restarted unexpectedly");
  }
  await prisma.task.updateMany({
    where: { id: { in: interrupted.map((t: { id: string }) => t.id) } },
    data: { status: "pending", retryCount: { increment: 1 } },
  });
  for (const t of interrupted) {
    console.log(`  - Reset to pending: ${t.id} (${t.title})`);
  }
}

async function updateWorkerHeartbeat(): Promise<void> {
  try {
    const now = new Date().toISOString();
    await prisma.setting.upsert({
      where: { key: "worker_last_seen" },
      create: { key: "worker_last_seen", value: now },
      update: { value: now },
    });
  } catch { /* non-fatal — heartbeat is best-effort */ }
}

/**
 * A pending/paused task row as loaded by the pick-up query, narrowed to the
 * fields the scheduling code actually reads. Declared explicitly because the
 * generated prisma client types `findMany` loosely here.
 */
interface EligibleTask extends ConcurrencyTask {
  title: string;
}

/**
 * Tasks currently occupying a slot, with the repos they touch — the input for
 * per-repo concurrency limits.
 *
 * Deliberately unions two sources: everything the DB says is `running` (covers
 * tasks another worker or a previous process owns) and the ids this process has
 * handed to runTask() but which may not have flipped to `running` in the DB
 * yet. Without that second half a repo could briefly look free and get a second
 * task started against it.
 */
async function getInFlightTasksWithRepos(
  inProcessIds: Set<string>,
): Promise<{ id: string; repos: { url: string }[] }[]> {
  const ids = Array.from(inProcessIds);
  return prisma.task.findMany({
    where: {
      OR: [
        { status: "running" },
        ...(ids.length > 0 ? [{ id: { in: ids } }] : []),
      ],
    },
    select: { id: true, repos: { select: { url: true } } },
  });
}

async function loadAllSettings(): Promise<Record<string, string>> {
  const rows: { key: string; value: string }[] = await prisma.setting.findMany();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function main() {
  // OpenTelemetry export is configured in Settings → Observability and re-read
  // every 15s, so toggling it takes effect without restarting the worker.
  await initTelemetry({ role: "worker", loadSettings: loadAllSettings, pollIntervalMs: 15_000 });
  console.log("Worker started.");
  await recoverInterruptedTasks();

  const runningTasks = new Set<string>();
  registerWorkerGauges(prisma, runningTasks);
  registerDbSizeGauges(resolveDbPath());
  // Tasks we've already told "you're waiting on a per-repo concurrency slot".
  // Cleared when the task finally starts, so a task that's held back twice
  // (e.g. after being requeued) explains itself again.
  const repoLimitNotified = new Set<string>();
  let lastCleanupAt = 0;
  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  let lastCredRefreshAt = 0;
  // Claude CLI OAuth access tokens are short-lived (issued for a few hours) and the
  // refresh token only gets exercised when we actually run the CLI. A 4-hour cadence
  // left long idle stretches (overnight, low-traffic periods) where the access token
  // sat expired between checks — by the time a task or the next scheduled refresh ran,
  // the CLI had to fall back on a refresh token that itself may have gone stale, which
  // surfaced as "credentials expired" failures. Refresh every 30 minutes instead so the
  // token is renewed well before it can lapse (also matches the Hail Mary cadence below).
  const CRED_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
  let lastHailMaryAt = 0;
  // Check for Hail Mary eligibility every 30 minutes (aligned with credential-refresh cadence)
  const HAIL_MARY_CHECK_INTERVAL_MS = 30 * 60 * 1000;
  let lastPRSyncAt = 0;
  const PR_SYNC_INTERVAL_MS = 2 * 60 * 1000;
  let restartPendingWarnedAt = 0;
  const RESTART_WARN_INTERVAL_MS = 60 * 1000;

  while (true) {
    // Heartbeat: let the UI know this worker process is alive
    void updateWorkerHeartbeat();

    // A backup restore swaps out the SQLite file this process has open. Only
    // restart while idle so we don't yank a running task's DB connection out
    // from under it — we'll notice again on the next poll (5s) once it's free.
    if (isRestartPending()) {
      if (runningTasks.size === 0) {
        restartForRestore("Detected a completed database restore");
        // In dev (no supervisor to relaunch us) restartForRestore just logs and
        // returns instead of exiting — fall through and keep polling as before.
      } else if (Date.now() - restartPendingWarnedAt >= RESTART_WARN_INTERVAL_MS) {
        restartPendingWarnedAt = Date.now();
        console.log(
          `Database restore detected — waiting for ${runningTasks.size} running task(s) to finish before restarting.`,
        );
      }
    }

    await triggerRecurringTasks();

    if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      lastCleanupAt = Date.now();
      runCleanup(prisma)
        .then(({ deleted }) => { if (deleted > 0) console.log(`Cleanup: removed ${deleted} old task(s)`); })
        .catch((err) => console.error("Cleanup error:", err));
    }

    if (Date.now() - lastCredRefreshAt >= CRED_REFRESH_INTERVAL_MS) {
      lastCredRefreshAt = Date.now();
      refreshCliCredentials().catch((err) => console.error("Credential refresh error:", err));
    }

    if (Date.now() - lastPRSyncAt >= PR_SYNC_INTERVAL_MS) {
      lastPRSyncAt = Date.now();
      syncPRStatuses().catch((err) => console.error("PR status sync error:", err));
    }

    // Hail Mary burst detector: non-blocking, runs on its own interval.
    // Fires-and-forgets so it never delays normally scheduled jobs.
    if (Date.now() - lastHailMaryAt >= HAIL_MARY_CHECK_INTERVAL_MS) {
      lastHailMaryAt = Date.now();
      runHailMaryDetector(prisma).catch((err) =>
        console.error("Hail Mary detector error:", err),
      );
    }

    const concurrentSetting = await prisma.setting.findUnique({ where: { key: "concurrent_tasks" } });
    const parsedConcurrent = concurrentSetting?.value ? parseInt(concurrentSetting.value, 10) : 1;
    const concurrentLimit = isNaN(parsedConcurrent) || parsedConcurrent < 1 ? 1 : parsedConcurrent;

    const throttleSetting = await prisma.setting.findUnique({ where: { key: "task_throttle_per_hour" } });
    const throttleLimit = throttleSetting?.value ? parseInt(throttleSetting.value, 10) : 0;
    if (throttleLimit > 0) {
      const started = await getTasksStartedInLastHour();
      if (started >= throttleLimit) {
        console.log(`Throttle limit reached (${started}/${throttleLimit} tasks in last hour). Waiting...`);
        const oneHourAgo = new Date(Date.now() - 3600000);
        const oldestLog = await prisma.taskLog.findFirst({
          where: { content: { startsWith: "Starting task:" }, level: "system", createdAt: { gte: oneHourAgo } },
          orderBy: { createdAt: "asc" },
        });
        const throttleLiftsAt = oldestLog
          ? new Date(oldestLog.createdAt.getTime() + 3600000)
          : new Date(Date.now() + 3600000);
        const now = new Date();
        await prisma.task.updateMany({
          where: {
            isRecurringTemplate: false,
            isEnabled: true,
            status: "pending",
            AND: [{ OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] }],
          },
          data: { status: "throttled", nextRetryAt: throttleLiftsAt },
        });
        await sleep(60000);
        continue;
      } else {
        // Throttle is under the limit — free any tasks stuck waiting due to old/changed throttle settings
        const now = new Date();
        await prisma.task.updateMany({
          where: {
            isRecurringTemplate: false,
            status: "throttled",
            retryCount: 0,
            nextRetryAt: { gt: now },
          },
          data: { nextRetryAt: now },
        });
      }
    }

    const availableSlots = concurrentLimit - runningTasks.size;

    if (availableSlots > 0) {
      const now = new Date();
      // Fetch every eligible task (not just `take`) so we can rank by priority before
      // slicing to the number of open slots — Prisma's orderBy sorts the `priority`
      // string column alphabetically, which doesn't match urgent > high > normal > low,
      // so the priority-aware ordering is applied in JS via comparePriorityThenPosition.
      // runnableTaskWhere() (src/lib/review-only.ts, unit-tested) also excludes
      // review-only tickets, which must never run whatever their status.
      const eligibleTasks = await prisma.task.findMany({
        where: runnableTaskWhere(now, Array.from(runningTasks)),
        orderBy: { position: "asc" },
        include: { repos: { select: { url: true } } },
      });
      const ranked = eligibleTasks.sort(comparePriorityThenPosition);

      // Per-repo caps: a repo can limit how many of its tasks run at once (see
      // src/lib/repo-concurrency.ts). Tasks whose repos are all under their cap
      // start as usual; the rest are skipped this cycle so a serialized repo
      // never blocks the tasks queued behind it for other repos.
      const repoLimits = buildRepoConcurrencyLimits(await getSavedRepos(prisma));
      // Explicit type argument: prisma's findMany is untyped (`any`) here, so
      // inference would otherwise collapse T to the bare ConcurrencyTask
      // constraint and lose `title` on the selected rows below.
      const { selected: tasks, blocked } = selectTasksWithinRepoLimits<EligibleTask>(ranked, {
        limits: repoLimits,
        // Only worth the extra query when at least one repo is actually capped.
        running: repoLimits.size > 0
          ? countTasksPerRepo(await getInFlightTasksWithRepos(runningTasks))
          : new Map<string, number>(),
        availableSlots,
      });

      for (const block of blocked) {
        // Explain the wait once per task per hold, so the timeline says why a
        // task is sitting in Pending without spamming a log line every 5s.
        if (repoLimitNotified.has(block.task.id)) continue;
        repoLimitNotified.add(block.task.id);
        const message = repoLimitWaitMessage(block);
        console.log(`Task ${block.task.id} held back — ${message}`);
        await log(block.task.id, message, "system").catch(() => {});
      }

      // Forget tasks that are no longer held back (started, deleted, or their
      // repo freed up). Keeps the set bounded and lets a task that gets held
      // back again later explain itself again.
      const stillBlocked = new Set(blocked.map((b) => b.task.id));
      for (const id of repoLimitNotified) {
        if (!stillBlocked.has(id)) repoLimitNotified.delete(id);
      }

      for (const task of tasks) {
        console.log(`Processing task: ${task.id} (${task.title})`);
        runningTasks.add(task.id);
        traceTaskRun(prisma, task.id, () => runTask(task.id))
          .catch((err) => {
            console.error(`Unhandled error for task ${task.id}:`, err);
            prisma.task.update({ where: { id: task.id }, data: { status: "failed" } }).catch(() => {});
          })
          .finally(() => {
            runningTasks.delete(task.id);
          });
      }

      if (tasks.length === 0) {
        await sleep(5000);
      }
    } else {
      await sleep(5000);
    }
  }
}

main().catch(console.error);
