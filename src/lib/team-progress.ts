/**
 * Team pipeline progress (`Task.teamProgress`).
 *
 * The worker's runTeamPipeline() records each stage's state here as the pipeline
 * moves through the team, and the task detail page renders it as a tracker
 * (who has finished, who is working now, who is still to come). Everything in
 * this module is pure so it can be unit-tested; the worker does the DB writes.
 */

export type TeamStageStatus = "pending" | "running" | "completed" | "awaiting_approval" | "failed" | "stopped" | "skipped";

/** What the UI shows. Adds states that only make sense next to the task's own status. */
export type TeamStageDisplayStatus = TeamStageStatus | "paused" | "interrupted";

export interface TeamStageProgress {
  memberId: string;
  name: string;
  status: TeamStageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Failure reason (failed) or why the pipeline stopped here (stopped). */
  note: string | null;
  /** The member is a manual approval gate (TeamMember.requiresApproval). */
  requiresApproval?: boolean;
  /**
   * What the stage produced (truncated), kept so the pipeline can pick up after it in a
   * later run — after an approval, the next stage is fed this instead of re-running it.
   */
  output?: string | null;
  /** Tokens the stage used, so a pipeline resumed after an approval still reports its total. */
  inputTokens?: number;
  outputTokens?: number;
  /** Set once a human approved this stage's output. */
  approval?: "approved" | null;
  approvedAt?: string | null;
  /** Optional notes the approver added — handed to the next stage. */
  approvalNote?: string | null;
  /**
   * A human asked for this stage to be redone with this feedback. The stage is back to
   * `pending`, `output` still holds the attempt being revised.
   */
  revisionFeedback?: string | null;
}

export interface TeamProgress {
  teamId: string;
  teamName: string;
  startedAt: string;
  finishedAt: string | null;
  stages: TeamStageProgress[];
}

export interface TeamRosterMember {
  id: string;
  name: string;
  requiresApproval?: boolean;
}

/** Task status while a team pipeline waits for a human to approve a stage. */
export const AWAITING_APPROVAL_STATUS = "awaiting_approval";

/** Cap on stored stage output / notes, so the progress JSON stays small. */
export const MAX_STAGE_OUTPUT_CHARS = 8000;
const MAX_NOTE_CHARS = 4000;

const STATUSES: readonly TeamStageStatus[] = ["pending", "running", "completed", "awaiting_approval", "failed", "stopped", "skipped"];

export function startTeamProgress(team: { id: string; name: string; members: TeamRosterMember[] }, now: Date): TeamProgress {
  return {
    teamId: team.id,
    teamName: team.name,
    startedAt: now.toISOString(),
    finishedAt: null,
    stages: team.members.map((m) => ({
      memberId: m.id,
      name: m.name,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      note: null,
      ...(m.requiresApproval ? { requiresApproval: true } : {}),
    })),
  };
}

function withStage(p: TeamProgress, index: number, patch: Partial<TeamStageProgress>): TeamProgress {
  return { ...p, stages: p.stages.map((s, i) => (i === index ? { ...s, ...patch } : s)) };
}

export function markStageRunning(p: TeamProgress, index: number, now: Date): TeamProgress {
  return withStage(p, index, { status: "running", startedAt: now.toISOString(), finishedAt: null, note: null });
}

export interface StageResultDetails {
  output?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

function resultPatch(details: StageResultDetails | undefined): Partial<TeamStageProgress> {
  if (!details) return {};
  return {
    ...(details.output !== undefined && { output: truncate(details.output, MAX_STAGE_OUTPUT_CHARS) }),
    ...(details.inputTokens !== undefined && { inputTokens: details.inputTokens }),
    ...(details.outputTokens !== undefined && { outputTokens: details.outputTokens }),
  };
}

function truncate(text: string | null, max: number): string | null {
  if (text == null) return null;
  return text.length > max ? `${text.slice(0, max)}\n\n*(truncated)*` : text;
}

export function markStageCompleted(p: TeamProgress, index: number, now: Date, details?: StageResultDetails): TeamProgress {
  const next = withStage(p, index, { status: "completed", finishedAt: now.toISOString(), ...resultPatch(details) });
  return index === p.stages.length - 1 ? { ...next, finishedAt: now.toISOString() } : next;
}

/**
 * The stage finished, but it's a manual approval gate: the pipeline stops here and the
 * task waits until a human approves (approveStage) or asks for a revision
 * (requestStageRevision). Only meaningful for a stage that isn't the last one.
 */
export function markStageAwaitingApproval(p: TeamProgress, index: number, now: Date, details?: StageResultDetails): TeamProgress {
  return withStage(p, index, {
    status: "awaiting_approval",
    finishedAt: now.toISOString(),
    requiresApproval: true,
    approval: null,
    approvalNote: null,
    revisionFeedback: null,
    ...resultPatch(details),
  });
}

/** Should the pipeline stop for approval after stage `index` of `total`? Never after the last one. */
export function stageNeedsApproval(member: { requiresApproval?: boolean | null }, index: number, total: number): boolean {
  return Boolean(member.requiresApproval) && index < total - 1;
}

/** Index of the stage waiting for approval, or -1. */
export function awaitingApprovalIndex(p: TeamProgress | null): number {
  return p ? p.stages.findIndex((s) => s.status === "awaiting_approval") : -1;
}

/**
 * A human approved the waiting stage: it becomes `completed` (approved), and the next
 * run of the task picks up at the stage after it (see planTeamResume). Returns null
 * when no stage is waiting.
 */
export function approveStage(
  p: TeamProgress,
  now: Date,
  note?: string | null,
): { progress: TeamProgress; index: number } | null {
  const index = awaitingApprovalIndex(p);
  if (index < 0) return null;
  const trimmed = note?.trim() || null;
  return {
    index,
    progress: withStage(p, index, {
      status: "completed",
      approval: "approved",
      approvedAt: now.toISOString(),
      approvalNote: truncate(trimmed, MAX_NOTE_CHARS),
      note: trimmed ? `Approved — ${trimmed}`.slice(0, 500) : "Approved",
    }),
  };
}

/**
 * A human wants the waiting stage redone: it goes back to `pending` carrying the
 * feedback (and its previous output), and the next run re-runs that stage first.
 * Returns null when no stage is waiting or the feedback is empty.
 */
export function requestStageRevision(
  p: TeamProgress,
  feedback: string,
): { progress: TeamProgress; index: number } | null {
  const index = awaitingApprovalIndex(p);
  const trimmed = feedback.trim();
  if (index < 0 || !trimmed) return null;
  return {
    index,
    progress: withStage(p, index, {
      status: "pending",
      startedAt: null,
      finishedAt: null,
      approval: null,
      approvalNote: null,
      revisionFeedback: truncate(trimmed, MAX_NOTE_CHARS),
      note: `Changes requested — ${trimmed}`.slice(0, 500),
    }),
  };
}

export interface TeamResumePlan {
  /** First stage to run in this run. */
  startIndex: number;
  /** Progress to continue from: stages before `startIndex` kept, the rest reset to pending. */
  progress: TeamProgress;
  /** Output of the stage before `startIndex`, to carry forward. */
  previousOutput: string;
  /** The stage before `startIndex` was approved by a human. */
  previousApproved: boolean;
  /** Approver's notes on the stage before `startIndex`, if any. */
  approvalNote: string | null;
  /** Set when `startIndex` is being redone at a human's request. */
  revision: { feedback: string; previousOutput: string } | null;
  /** True when the stage at `startIndex` never started (vs. one interrupted mid-run). */
  freshStage: boolean;
  /** Tokens already spent by the stages before `startIndex`. */
  inputTokens: number;
  outputTokens: number;
}

/**
 * Where a team pipeline should pick up, given what a previous run recorded. Only an
 * approval decision makes a run skip ahead: a stage waiting on a revision is re-run,
 * otherwise the stage after the latest approved gate runs next. Everything else (no
 * decision, or the roster no longer matches the stages already done) returns null and
 * the pipeline starts from the first member as before.
 */
export function planTeamResume(progress: TeamProgress | null, members: TeamRosterMember[], now: Date): TeamResumePlan | null {
  if (!progress || members.length === 0) return null;
  const stages = progress.stages;

  let startIndex = stages.findIndex((s) => s.status === "pending" && s.revisionFeedback);
  if (startIndex < 0) {
    let lastApproved = -1;
    stages.forEach((s, i) => { if (s.approval === "approved") lastApproved = i; });
    if (lastApproved < 0) return null;
    startIndex = lastApproved + 1;
  }
  if (startIndex >= members.length) return null;
  for (let i = 0; i < startIndex; i++) {
    if (stages[i]?.memberId !== members[i].id || stages[i].status !== "completed") return null;
  }

  const startStage = stages[startIndex]?.memberId === members[startIndex].id ? stages[startIndex] : undefined;
  const before = startIndex > 0 ? stages[startIndex - 1] : undefined;
  const revision = startStage?.revisionFeedback
    ? { feedback: startStage.revisionFeedback, previousOutput: startStage.output ?? "" }
    : null;

  const kept = stages.slice(0, startIndex);
  const fresh: TeamStageProgress[] = members.slice(startIndex).map((m) => ({
    memberId: m.id,
    name: m.name,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    note: null,
    ...(m.requiresApproval ? { requiresApproval: true } : {}),
  }));

  return {
    startIndex,
    progress: { ...progress, startedAt: progress.startedAt || now.toISOString(), finishedAt: null, stages: [...kept, ...fresh] },
    previousOutput: before?.output ?? "",
    previousApproved: before?.approval === "approved",
    approvalNote: before?.approval === "approved" ? before.approvalNote ?? null : null,
    revision,
    freshStage: !startStage || startStage.status !== "running",
    inputTokens: kept.reduce((n, s) => n + (s.inputTokens ?? 0), 0),
    outputTokens: kept.reduce((n, s) => n + (s.outputTokens ?? 0), 0),
  };
}

/**
 * The pipeline ended at `index` without finishing: `failed` for an error, `stopped`
 * for a deliberate halt (budget reached). Every later stage becomes `skipped`.
 */
export function markStageEnded(
  p: TeamProgress,
  index: number,
  status: "failed" | "stopped",
  note: string | null,
  now: Date,
  details?: Pick<StageResultDetails, "inputTokens" | "outputTokens">,
): TeamProgress {
  const iso = now.toISOString();
  return {
    ...p,
    finishedAt: iso,
    stages: p.stages.map((s, i) => {
      if (i === index) return { ...s, status, finishedAt: iso, note: note ? note.slice(0, 500) : null, ...resultPatch(details) };
      if (i > index && s.status === "pending") return { ...s, status: "skipped" };
      return s;
    }),
  };
}

export function serializeTeamProgress(p: TeamProgress): string {
  return JSON.stringify(p);
}

/** Lenient parse of the stored JSON — anything malformed yields null rather than throwing. */
export function parseTeamProgress(raw: string | null | undefined): TeamProgress | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.stages)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const stages: TeamStageProgress[] = [];
  for (const s of o.stages) {
    if (!s || typeof s !== "object") continue;
    const st = s as Record<string, unknown>;
    const name = str(st.name);
    if (!name) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    stages.push({
      memberId: str(st.memberId) ?? "",
      name,
      status: STATUSES.includes(st.status as TeamStageStatus) ? (st.status as TeamStageStatus) : "pending",
      startedAt: str(st.startedAt),
      finishedAt: str(st.finishedAt),
      note: str(st.note),
      ...(st.requiresApproval === true && { requiresApproval: true }),
      ...(str(st.output) !== null && { output: str(st.output) }),
      ...(num(st.inputTokens) !== undefined && { inputTokens: num(st.inputTokens) }),
      ...(num(st.outputTokens) !== undefined && { outputTokens: num(st.outputTokens) }),
      ...(st.approval === "approved" && { approval: "approved" as const }),
      ...(str(st.approvedAt) !== null && { approvedAt: str(st.approvedAt) }),
      ...(str(st.approvalNote) !== null && { approvalNote: str(st.approvalNote) }),
      ...(str(st.revisionFeedback) !== null && { revisionFeedback: str(st.revisionFeedback) }),
    });
  }
  return {
    teamId: str(o.teamId) ?? "",
    teamName: str(o.teamName) ?? "",
    startedAt: str(o.startedAt) ?? "",
    finishedAt: str(o.finishedAt),
    stages,
  };
}

export interface TeamStageView {
  key: string;
  name: string;
  status: TeamStageDisplayStatus;
  startedAt: string | null;
  finishedAt: string | null;
  note: string | null;
  requiresApproval: boolean;
  /** What the stage produced — shown for a stage waiting on approval so it can be reviewed. */
  output: string | null;
  /** Tokens the stage used, once it has finished (null while running or never run). */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface TeamProgressView {
  stages: TeamStageView[];
  completed: number;
  total: number;
  /** Index of the stage working right now, if any. */
  currentIndex: number | null;
  /** Index of the stage waiting for a human to approve it, if any. */
  awaitingIndex: number | null;
  /** True when the stages come from a recorded run, false when only the roster is known. */
  hasRun: boolean;
}

const ACTIVE_TASK_STATUSES = new Set(["running"]);
const WAITING_TASK_STATUSES = new Set(["pending", "paused", "throttled", "backlog", AWAITING_APPROVAL_STATUS]);

/**
 * Combine the recorded progress with the task's current status (and the team's
 * roster, for a task that hasn't run yet) into what the tracker should show.
 *
 * A stage recorded as `running` is only really running while the task is — if the
 * task has since been paused (rate limit) it shows as `paused`, and if it was
 * killed/timed out/crashed it shows as `interrupted`.
 */
export function buildTeamProgressView(
  progress: TeamProgress | null,
  roster: TeamRosterMember[],
  taskStatus: string,
): TeamProgressView {
  if (!progress || progress.stages.length === 0) {
    return {
      stages: roster.map((m) => ({
        key: m.id, name: m.name, status: "pending", startedAt: null, finishedAt: null, note: null,
        requiresApproval: Boolean(m.requiresApproval), output: null, inputTokens: null, outputTokens: null,
      })),
      completed: 0,
      total: roster.length,
      currentIndex: null,
      awaitingIndex: null,
      hasRun: false,
    };
  }
  const taskActive = ACTIVE_TASK_STATUSES.has(taskStatus);
  let currentIndex: number | null = null;
  let awaitingIndex: number | null = null;
  const stages = progress.stages.map((s, i): TeamStageView => {
    let status: TeamStageDisplayStatus = s.status;
    if (s.status === "awaiting_approval") {
      // Only a task that is still waiting can be approved; one cancelled while it waited
      // ended at this stage.
      if (taskStatus === AWAITING_APPROVAL_STATUS) awaitingIndex = i;
      else status = "stopped";
    } else if (s.status === "running") {
      if (taskActive) currentIndex = i;
      else status = WAITING_TASK_STATUSES.has(taskStatus) ? "paused" : "interrupted";
    } else if (s.status === "pending" && !taskActive && !WAITING_TASK_STATUSES.has(taskStatus)) {
      // The run ended (killed, crashed) before reaching this stage.
      status = "skipped";
    }
    return {
      key: s.memberId || `${i}-${s.name}`, name: s.name, status, startedAt: s.startedAt, finishedAt: s.finishedAt,
      note: status === "stopped" && s.status === "awaiting_approval" ? s.note ?? "Not approved" : s.note,
      requiresApproval: Boolean(s.requiresApproval),
      output: s.output ?? null,
      inputTokens: s.inputTokens ?? null,
      outputTokens: s.outputTokens ?? null,
    };
  });
  return {
    stages,
    completed: stages.filter((s) => s.status === "completed" || s.status === "awaiting_approval").length,
    total: stages.length,
    currentIndex,
    awaitingIndex,
    hasRun: true,
  };
}

/** Prefix for a log line produced by a team member, e.g. "[Reviewer] ". */
export function memberLogPrefix(member: string | null | undefined): string {
  return member ? `[${member}] ` : "";
}
