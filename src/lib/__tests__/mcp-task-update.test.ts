import { test } from "node:test";
import assert from "node:assert/strict";
import { McpToolError } from "../mcp/protocol";
import {
  gitModeOfTask,
  nextCronRun,
  parseMaxRunsArg,
  parseProviderArg,
  planTaskEdit,
  validateCron,
  type EditableTask,
} from "../mcp/task-update";

function task(overrides: Partial<EditableTask> = {}): EditableTask {
  return {
    id: "t1",
    status: "pending",
    labels: null,
    notes: null,
    outputType: "repository",
    pushToMain: false,
    createPR: false,
    targetBranch: null,
    toolAccess: null,
    isRecurringTemplate: false,
    cronExpression: null,
    repos: [
      { alias: "api", url: "https://github.com/acme/api.git", branch: "main" },
      { alias: "web", url: "https://github.com/acme/web.git", branch: null },
    ],
    ...overrides,
  };
}

const rejects = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof McpToolError && re.test(e.message));

test("gitModeOfTask follows the worker's precedence", () => {
  assert.equal(gitModeOfTask(task()), "branch");
  assert.equal(gitModeOfTask(task({ createPR: true })), "pr");
  assert.equal(gitModeOfTask(task({ pushToMain: true, createPR: true })), "main");
  assert.equal(gitModeOfTask(task({ targetBranch: "release" })), "target");
});

test("afterCompletion sets all three git columns", () => {
  assert.deepEqual(planTaskEdit(task({ targetBranch: "x" }), { afterCompletion: "pr" }).data, {
    pushToMain: false, createPR: true, targetBranch: null,
  });
  assert.deepEqual(planTaskEdit(task({ createPR: true }), { afterCompletion: "target", targetBranch: "release" }).data, {
    pushToMain: false, createPR: false, targetBranch: "release",
  });
});

test("a bare targetBranch switches to target mode", () => {
  assert.deepEqual(planTaskEdit(task({ createPR: true }), { targetBranch: "develop" }).data, {
    pushToMain: false, createPR: false, targetBranch: "develop",
  });
});

test("target mode keeps the existing target branch, and needs one", () => {
  assert.equal(planTaskEdit(task({ targetBranch: "rel" }), { afterCompletion: "target" }).data.targetBranch, "rel");
  rejects(() => planTaskEdit(task(), { afterCompletion: "target" }), /targetBranch' is required/);
  rejects(() => planTaskEdit(task(), { afterCompletion: "pr", targetBranch: "x" }), /only applies/);
  rejects(() => planTaskEdit(task(), { targetBranch: "" }), /needs an 'afterCompletion'/);
});

test("repoBranches changes only the named repos, by alias or URL", () => {
  const plan = planTaskEdit(task(), { repoBranches: { web: "develop" } });
  assert.deepEqual(plan.repos, [
    { alias: "api", url: "https://github.com/acme/api.git", branch: "main" },
    { alias: "web", url: "https://github.com/acme/web.git", branch: "develop" },
  ]);
  const byUrl = planTaskEdit(task(), { repoBranches: { "https://github.com/acme/api.git": "" } });
  assert.equal(byUrl.repos![0].branch, undefined, "empty string asks for the repo default");
  assert.equal(byUrl.repos![1].branch, null, "untouched repos keep their stored branch");
});

test("repoBranches rejects an unknown repo and listing the real ones", () => {
  rejects(() => planTaskEdit(task(), { repoBranches: { mobile: "dev" } }), /no repo 'mobile'.*api, web/);
  rejects(() => planTaskEdit(task(), { repos: [], repoBranches: {} }), /not both/);
});

test("repos replaces the list; a repository task can't end up with none", () => {
  const plan = planTaskEdit(task(), { repos: ["git@github.com:acme/cli.git", { url: "https://x/y.git", branch: "dev", alias: "y2" }] });
  assert.deepEqual(plan.repos, [
    { alias: "cli", url: "git@github.com:acme/cli.git", branch: undefined },
    { alias: "y2", url: "https://x/y.git", branch: "dev" },
  ]);
  rejects(() => planTaskEdit(task(), { repos: [] }), /at least one repo/);
  assert.deepEqual(planTaskEdit(task(), { repos: [], outputType: "file" }).repos, []);
  rejects(() => planTaskEdit(task({ repos: [] }), { outputType: "repository" }), /at least one repo/);
});

test("run settings: dependency, team, subtasks, budgets", () => {
  const plan = planTaskEdit(task(), { dependsOnTaskId: "t0", teamId: "", allowSubtasks: true, tokenBudget: 0, costBudget: 2.5 });
  assert.equal(plan.dependsOnTaskId, "t0");
  assert.equal(plan.teamId, null);
  assert.deepEqual(plan.data, { dependsOnTaskId: "t0", teamId: null, allowSubtasks: true, tokenBudget: null, costBudget: 2.5 });
  rejects(() => planTaskEdit(task(), { dependsOnTaskId: "t1" }), /depend on itself/);
});

test("toolAccess merges onto the task's overrides; null drops one", () => {
  const t = task({ toolAccess: JSON.stringify({ "github-cli": false }) });
  assert.equal(planTaskEdit(t, { toolAccess: { "github-cli": true } }).data.toolAccess, JSON.stringify({ "github-cli": true }));
  assert.equal(planTaskEdit(t, { toolAccess: { "github-cli": null } }).data.toolAccess, null);
  rejects(() => planTaskEdit(t, { toolAccess: { aws: true } }), /unknown tool 'aws'/);
});

test("a running task only accepts cosmetic edits", () => {
  const running = task({ status: "running" });
  assert.deepEqual(planTaskEdit(running, { priority: "high", addLabels: ["x"] }).data, { priority: "high", labels: '["x"]' });
  rejects(() => planTaskEdit(running, { afterCompletion: "pr" }), /running, so afterCompletion/);
  rejects(() => planTaskEdit(running, { repoBranches: { api: "dev" } }), /running, so repoBranches/);
  rejects(() => planTaskEdit(running, { enabled: false }), /cancel_task/);
});

test("labels, notes and empty calls behave as before", () => {
  const t = task({ labels: '["a","b"]', notes: "old" });
  assert.equal(planTaskEdit(t, { addLabels: ["c"], removeLabels: ["a"] }).data.labels, '["b","c"]');
  assert.equal(planTaskEdit(t, { appendNote: "new" }).data.notes, "old\n\nnew");
  rejects(() => planTaskEdit(t, { id: "t1" }), /Nothing to update/);
});

test("provider: id pins, 'smart' picks, empty clears", () => {
  assert.deepEqual(parseProviderArg({ provider: "p1" }), { aiProviderId: "p1", useSmartProvider: false });
  assert.deepEqual(parseProviderArg({ provider: "Smart" }), { aiProviderId: null, useSmartProvider: true });
  assert.deepEqual(parseProviderArg({ provider: "" }), { aiProviderId: null, useSmartProvider: false });
  assert.equal(parseProviderArg({}), undefined);
  const plan = planTaskEdit(task(), { provider: "p1" });
  assert.equal(plan.aiProviderId, "p1");
  assert.deepEqual(plan.data, { aiProviderId: "p1", useSmartProvider: false });
  rejects(() => planTaskEdit(task({ status: "running" }), { provider: "smart" }), /running, so provider/);
});

test("validateCron accepts what the worker parses and explains what it doesn't", () => {
  assert.equal(validateCron(" 0 9 * * 1-5 "), "0 9 * * 1-5");
  rejects(() => validateCron("every monday"), /isn't a valid cron expression/);
  rejects(() => validateCron("0 25 * * *"), /isn't a valid cron expression/);
});

test("maxRuns: positive integer, or 0/null for unlimited", () => {
  assert.equal(parseMaxRunsArg({ maxRuns: 5 }), 5);
  assert.equal(parseMaxRunsArg({ maxRuns: 0 }), null);
  assert.equal(parseMaxRunsArg({ maxRuns: null }), null);
  assert.equal(parseMaxRunsArg({}), undefined);
  rejects(() => parseMaxRunsArg({ maxRuns: -2 }), /at least 1/);
});

test("schedule edits only apply to recurring templates", () => {
  rejects(() => planTaskEdit(task(), { cronExpression: "0 9 * * *" }), /only apply to recurring templates/);
  const template = task({ isRecurringTemplate: true, cronExpression: "0 9 * * *" });
  const plan = planTaskEdit(template, { cronExpression: "30 8 * * 1", maxRuns: 10, resetRunCount: true });
  assert.equal(plan.data.cronExpression, "30 8 * * 1");
  assert.ok(plan.data.lastScheduledAt instanceof Date, "a new schedule is counted from now");
  assert.equal(plan.data.maxRuns, 10);
  assert.equal(plan.data.runCount, 0);
  rejects(() => planTaskEdit(template, { cronExpression: "" }), /enabled: false/);
  assert.equal(planTaskEdit(template, { cronExpression: "0 9 * * *", maxRuns: 0 }).data.lastScheduledAt, undefined,
    "re-sending the same schedule doesn't move its anchor");
});

test("nextCronRun", () => {
  const base = {
    cronExpression: "0 9 * * *", isEnabled: true, maxRuns: null, runCount: 0,
    lastScheduledAt: new Date("2026-11-10T09:00:00"), createdAt: new Date("2026-01-01T00:00:00"),
  };
  const now = new Date("2026-11-10T12:00:00");
  assert.equal(nextCronRun(base, now)?.getTime(), new Date("2026-11-11T09:00:00").getTime());
  assert.equal(nextCronRun({ ...base, lastScheduledAt: new Date("2026-11-01T09:00:00") }, now)?.getTime(), now.getTime(), "overdue fires now");
  assert.equal(nextCronRun({ ...base, isEnabled: false }, now), null);
  assert.equal(nextCronRun({ ...base, maxRuns: 3, runCount: 3 }, now), null);
});
