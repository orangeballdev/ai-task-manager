import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AWAITING_APPROVAL_STATUS,
  MAX_STAGE_OUTPUT_CHARS,
  approveStage,
  awaitingApprovalIndex,
  markStageAwaitingApproval,
  planTeamResume,
  requestStageRevision,
  stageNeedsApproval,
  type TeamProgress,
  buildTeamProgressView,
  markStageCompleted,
  markStageEnded,
  markStageRunning,
  memberLogPrefix,
  parseTeamProgress,
  serializeTeamProgress,
  startTeamProgress,
} from "../team-progress";

const team = {
  id: "t1",
  name: "Squad",
  members: [
    { id: "a", name: "Planner" },
    { id: "b", name: "Coder" },
    { id: "c", name: "Reviewer" },
  ],
};
const t0 = new Date("2026-01-01T00:00:00Z");
const t1 = new Date("2026-01-01T00:01:00Z");

test("startTeamProgress puts every member in pending", () => {
  const p = startTeamProgress(team, t0);
  assert.equal(p.teamName, "Squad");
  assert.deepEqual(p.stages.map((s) => s.status), ["pending", "pending", "pending"]);
  assert.equal(p.finishedAt, null);
});

test("stages move running -> completed and the run finishes after the last", () => {
  let p = startTeamProgress(team, t0);
  p = markStageRunning(p, 0, t0);
  assert.equal(p.stages[0].status, "running");
  assert.equal(p.stages[0].startedAt, t0.toISOString());
  p = markStageCompleted(p, 0, t1);
  assert.equal(p.stages[0].status, "completed");
  assert.equal(p.finishedAt, null);
  p = markStageCompleted(markStageRunning(markStageCompleted(markStageRunning(p, 1, t1), 1, t1), 2, t1), 2, t1);
  assert.equal(p.finishedAt, t1.toISOString());
});

test("markStageEnded fails a stage and skips the rest", () => {
  let p = markStageRunning(startTeamProgress(team, t0), 1, t0);
  p = markStageEnded(p, 1, "failed", "boom", t1);
  assert.deepEqual(p.stages.map((s) => s.status), ["pending", "failed", "skipped"]);
  assert.equal(p.stages[1].note, "boom");
  assert.equal(p.finishedAt, t1.toISOString());
});

test("stage tokens are recorded on completed and failed stages and shown in the view", () => {
  let p = markStageRunning(startTeamProgress(team, t0), 0, t0);
  p = markStageCompleted(p, 0, t1, { inputTokens: 10, outputTokens: 200 });
  p = markStageRunning(p, 1, t1);
  p = markStageEnded(p, 1, "failed", "boom", t1, { inputTokens: 5, outputTokens: 50 });
  const v = buildTeamProgressView(p, [], "failed");
  assert.deepEqual(v.stages.map((s) => [s.inputTokens, s.outputTokens]), [[10, 200], [5, 50], [null, null]]);
  assert.deepEqual(buildTeamProgressView(null, team.members, "pending").stages[0].inputTokens, null);
});

test("parseTeamProgress round-trips and tolerates junk", () => {
  const p = markStageRunning(startTeamProgress(team, t0), 0, t0);
  assert.deepEqual(parseTeamProgress(serializeTeamProgress(p)), p);
  assert.equal(parseTeamProgress(null), null);
  assert.equal(parseTeamProgress("not json"), null);
  assert.equal(parseTeamProgress("{}"), null);
  const odd = parseTeamProgress(JSON.stringify({ stages: [{ name: "X", status: "weird" }, { status: "running" }] }));
  assert.equal(odd?.stages.length, 1);
  assert.equal(odd?.stages[0].status, "pending");
});

test("view falls back to the roster before the first run", () => {
  const v = buildTeamProgressView(null, team.members, "pending");
  assert.equal(v.hasRun, false);
  assert.equal(v.total, 3);
  assert.equal(v.currentIndex, null);
  assert.deepEqual(v.stages.map((s) => s.name), ["Planner", "Coder", "Reviewer"]);
});

test("view reports the current stage while the task runs", () => {
  const p = markStageRunning(markStageCompleted(markStageRunning(startTeamProgress(team, t0), 0, t0), 0, t1), 1, t1);
  const v = buildTeamProgressView(p, team.members, "running");
  assert.equal(v.currentIndex, 1);
  assert.equal(v.completed, 1);
  assert.deepEqual(v.stages.map((s) => s.status), ["completed", "running", "pending"]);
});

test("a recorded running stage is paused or interrupted once the task stops", () => {
  const p = markStageRunning(startTeamProgress(team, t0), 0, t0);
  assert.deepEqual(buildTeamProgressView(p, [], "paused").stages.map((s) => s.status), ["paused", "pending", "pending"]);
  const killed = buildTeamProgressView(p, [], "killed");
  assert.equal(killed.currentIndex, null);
  assert.deepEqual(killed.stages.map((s) => s.status), ["interrupted", "skipped", "skipped"]);
});

test("memberLogPrefix", () => {
  assert.equal(memberLogPrefix("Coder"), "[Coder] ");
  assert.equal(memberLogPrefix(null), "");
});

// ---------------------------------------------------------------------------
// Manual approval gates
// ---------------------------------------------------------------------------

const gatedTeam = {
  id: "t2",
  name: "Gated",
  members: [
    { id: "p", name: "Planner", requiresApproval: true },
    { id: "c", name: "Coder" },
    { id: "r", name: "Reviewer" },
  ],
};

function runToGate(): TeamProgress {
  let p = startTeamProgress(gatedTeam, t0);
  p = markStageRunning(p, 0, t0);
  return markStageAwaitingApproval(p, 0, t1, { output: "1. Do X\n2. Do Y", inputTokens: 100, outputTokens: 20 });
}

test("startTeamProgress records which members are approval gates", () => {
  const p = startTeamProgress(gatedTeam, t0);
  assert.deepEqual(p.stages.map((s) => Boolean(s.requiresApproval)), [true, false, false]);
});

test("stageNeedsApproval never gates the last member", () => {
  assert.equal(stageNeedsApproval({ requiresApproval: true }, 0, 3), true);
  assert.equal(stageNeedsApproval({ requiresApproval: true }, 2, 3), false);
  assert.equal(stageNeedsApproval({ requiresApproval: false }, 0, 3), false);
  assert.equal(stageNeedsApproval({}, 0, 3), false);
});

test("a gated stage waits with its output and tokens, and survives a serialize round trip", () => {
  const p = parseTeamProgress(serializeTeamProgress(runToGate()))!;
  assert.equal(awaitingApprovalIndex(p), 0);
  assert.equal(p.stages[0].status, "awaiting_approval");
  assert.equal(p.stages[0].output, "1. Do X\n2. Do Y");
  assert.equal(p.stages[0].inputTokens, 100);
  assert.equal(p.finishedAt, null);
});

test("long stage output is truncated when stored", () => {
  let p = startTeamProgress(gatedTeam, t0);
  p = markStageAwaitingApproval(p, 0, t1, { output: "x".repeat(MAX_STAGE_OUTPUT_CHARS + 50) });
  assert.ok(p.stages[0].output!.length < MAX_STAGE_OUTPUT_CHARS + 50);
  assert.match(p.stages[0].output!, /truncated/);
});

test("the tracker shows the waiting stage only while the task is awaiting approval", () => {
  const p = runToGate();
  const waiting = buildTeamProgressView(p, [], AWAITING_APPROVAL_STATUS);
  assert.equal(waiting.awaitingIndex, 0);
  assert.equal(waiting.stages[0].status, "awaiting_approval");
  assert.equal(waiting.stages[0].output, "1. Do X\n2. Do Y");
  // Later stages are still to come, not skipped.
  assert.equal(waiting.stages[1].status, "pending");

  const killed = buildTeamProgressView(p, [], "killed");
  assert.equal(killed.awaitingIndex, null);
  assert.equal(killed.stages[0].status, "stopped");
  assert.equal(killed.stages[1].status, "skipped");
});

test("approveStage completes the gate with the approver's notes", () => {
  const decided = approveStage(runToGate(), t1, "  Use Postgres  ")!;
  assert.equal(decided.index, 0);
  const s = decided.progress.stages[0];
  assert.equal(s.status, "completed");
  assert.equal(s.approval, "approved");
  assert.equal(s.approvalNote, "Use Postgres");
  assert.equal(s.output, "1. Do X\n2. Do Y");
  assert.equal(approveStage(decided.progress, t1), null, "nothing left to approve");
});

test("requestStageRevision sends the stage back with feedback, and needs feedback", () => {
  assert.equal(requestStageRevision(runToGate(), "   "), null);
  const decided = requestStageRevision(runToGate(), "Split step 2")!;
  const s = decided.progress.stages[0];
  assert.equal(s.status, "pending");
  assert.equal(s.revisionFeedback, "Split step 2");
  assert.equal(s.output, "1. Do X\n2. Do Y");
});

test("planTeamResume continues after an approved gate, carrying its output, notes and tokens", () => {
  const approved = approveStage(runToGate(), t1, "Use Postgres")!.progress;
  const plan = planTeamResume(approved, gatedTeam.members, t1)!;
  assert.equal(plan.startIndex, 1);
  assert.equal(plan.previousOutput, "1. Do X\n2. Do Y");
  assert.equal(plan.previousApproved, true);
  assert.equal(plan.approvalNote, "Use Postgres");
  assert.equal(plan.revision, null);
  assert.equal(plan.freshStage, true);
  assert.equal(plan.inputTokens, 100);
  assert.equal(plan.outputTokens, 20);
  assert.deepEqual(plan.progress.stages.map((s) => s.status), ["completed", "pending", "pending"]);
});

test("planTeamResume re-runs a stage sent back for revision", () => {
  const revised = requestStageRevision(runToGate(), "Split step 2")!.progress;
  const plan = planTeamResume(revised, gatedTeam.members, t1)!;
  assert.equal(plan.startIndex, 0);
  assert.deepEqual(plan.revision, { feedback: "Split step 2", previousOutput: "1. Do X\n2. Do Y" });
  assert.equal(plan.inputTokens, 0);
  assert.equal(plan.progress.stages[0].status, "pending");
  assert.equal(plan.progress.stages[0].revisionFeedback, undefined);
});

test("planTeamResume treats a stage interrupted after an approval as a resume, not a fresh start", () => {
  let p = approveStage(runToGate(), t1)!.progress;
  p = markStageRunning(p, 1, t1); // then a rate limit parked the task
  const plan = planTeamResume(p, gatedTeam.members, t1)!;
  assert.equal(plan.startIndex, 1);
  assert.equal(plan.freshStage, false);
});

test("planTeamResume starts over without a decision, or when the roster changed", () => {
  assert.equal(planTeamResume(null, gatedTeam.members, t1), null);
  assert.equal(planTeamResume(runToGate(), gatedTeam.members, t1), null, "still waiting — no decision yet");
  const approved = approveStage(runToGate(), t1)!.progress;
  const reordered = [gatedTeam.members[1], gatedTeam.members[0], gatedTeam.members[2]];
  assert.equal(planTeamResume(approved, reordered, t1), null);
});

test("planTeamResume picks up roster changes after the approved stage", () => {
  const approved = approveStage(runToGate(), t1)!.progress;
  const plan = planTeamResume(approved, [gatedTeam.members[0], { id: "x", name: "Tester" }], t1)!;
  assert.deepEqual(plan.progress.stages.map((s) => s.name), ["Planner", "Tester"]);
});
