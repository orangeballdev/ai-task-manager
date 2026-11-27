import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSubtaskRequests,
  buildSubtaskContext,
  buildSubtasksPromptSection,
  MAX_SUBTASKS_PER_RUN,
  SUBTASKS_FILE,
} from "../subtasks";

test("parses a bare array of subtasks", () => {
  const { subtasks, warnings } = parseSubtaskRequests(JSON.stringify([
    { title: "Exam A", description: "Clean up exam A", context: "id=1" },
    { title: "Exam B", description: "Clean up exam B", dependsOnPrevious: true },
  ]));
  assert.deepEqual(warnings, []);
  assert.equal(subtasks.length, 2);
  assert.deepEqual(subtasks[0], { title: "Exam A", description: "Clean up exam A", context: "id=1", repos: null, dependsOnPrevious: false });
  assert.equal(subtasks[1].dependsOnPrevious, true);
  assert.equal(subtasks[1].context, null);
});

test("accepts a { subtasks: [...] } wrapper", () => {
  const { subtasks } = parseSubtaskRequests(JSON.stringify({ subtasks: [{ description: "Do it" }] }));
  assert.equal(subtasks.length, 1);
  assert.equal(subtasks[0].title, "Do it");
});

test("title alone doubles as the description", () => {
  const { subtasks } = parseSubtaskRequests(JSON.stringify([{ title: "Only a title" }]));
  assert.equal(subtasks[0].description, "Only a title");
});

test("invalid JSON and wrong shapes produce warnings, not throws", () => {
  assert.equal(parseSubtaskRequests("{nope").subtasks.length, 0);
  assert.match(parseSubtaskRequests("{nope").warnings[0], /not valid JSON/);
  assert.match(parseSubtaskRequests('{"a":1}').warnings[0], /must contain a JSON array/);
  const { subtasks, warnings } = parseSubtaskRequests(JSON.stringify([null, 5, {}, { description: "ok" }]));
  assert.equal(subtasks.length, 1);
  assert.equal(warnings.length, 3);
});

test("repo aliases are filtered to the parent's repos", () => {
  const { subtasks, warnings } = parseSubtaskRequests(
    JSON.stringify([
      { description: "a", repos: ["web", "ghost"] },
      { description: "b", repos: ["ghost"] },
      { description: "c", repos: ["api", "api"] },
    ]),
    ["web", "api"],
  );
  assert.deepEqual(subtasks[0].repos, ["web"]);
  assert.equal(subtasks[1].repos, null); // all unknown -> fall back to every parent repo
  assert.deepEqual(subtasks[2].repos, ["api"]);
  assert.equal(warnings.length, 2);
});

test("caps the number of subtasks per run", () => {
  const many = Array.from({ length: MAX_SUBTASKS_PER_RUN + 5 }, (_, i) => ({ description: `t${i}` }));
  const { subtasks, warnings } = parseSubtaskRequests(JSON.stringify(many));
  assert.equal(subtasks.length, MAX_SUBTASKS_PER_RUN);
  assert.match(warnings[0], /only the first/);
});

test("buildSubtaskContext references the parent and keeps the agent's context", () => {
  const ctx = buildSubtaskContext({ id: "p1", title: "Parent" }, "extra");
  assert.match(ctx, /subtask of "Parent" \(task p1\)/);
  assert.ok(ctx.endsWith("extra"));
  assert.ok(!buildSubtaskContext({ id: "p1", title: "Parent" }, null).includes("\n"));
});

test("prompt section points at the workspace file", () => {
  const section = buildSubtasksPromptSection("/workspaces/abc/", ["web"]);
  assert.ok(section.includes(`/workspaces/abc/${SUBTASKS_FILE}`));
  assert.ok(section.includes("(web)"));
});
