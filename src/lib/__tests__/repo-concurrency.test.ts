import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRepoConcurrencyLimits,
  countTasksPerRepo,
  repoLimitWaitMessage,
  selectTasksWithinRepoLimits,
  taskRepoScopes,
} from "../repo-concurrency";

const task = (id: string, ...urls: string[]) => ({ id, repos: urls.map((url) => ({ url })) });

test("buildRepoConcurrencyLimits keys limits by normalized scope", () => {
  const limits = buildRepoConcurrencyLimits([
    { url: "git@github.com:acme/foo.git", maxConcurrentTasks: 1 },
    { url: "https://github.com/acme/bar", maxConcurrentTasks: 3 },
  ]);

  assert.equal(limits.get("github.com/acme/foo"), 1);
  assert.equal(limits.get("github.com/acme/bar"), 3);
});

test("buildRepoConcurrencyLimits omits repos with no cap", () => {
  const limits = buildRepoConcurrencyLimits([
    { url: "https://github.com/acme/foo" },
    { url: "https://github.com/acme/bar", maxConcurrentTasks: 0 },
    { url: "https://github.com/acme/baz", maxConcurrentTasks: -2 },
  ]);

  assert.equal(limits.size, 0);
});

test("buildRepoConcurrencyLimits keeps the strictest limit when two urls collide", () => {
  const limits = buildRepoConcurrencyLimits([
    { url: "https://github.com/acme/foo.git", maxConcurrentTasks: 4 },
    { url: "git@github.com:acme/foo.git", maxConcurrentTasks: 1 },
  ]);

  assert.equal(limits.size, 1);
  assert.equal(limits.get("github.com/acme/foo"), 1);
});

test("taskRepoScopes dedupes repos that normalize to the same scope", () => {
  const scopes = taskRepoScopes(
    task("t1", "https://github.com/acme/foo.git", "git@github.com:acme/foo.git"),
  );

  assert.deepEqual(scopes, ["github.com/acme/foo"]);
});

test("countTasksPerRepo counts a multi-repo task against each of its repos", () => {
  const counts = countTasksPerRepo([
    task("t1", "https://github.com/acme/foo", "https://github.com/acme/bar"),
    task("t2", "https://github.com/acme/foo"),
  ]);

  assert.equal(counts.get("github.com/acme/foo"), 2);
  assert.equal(counts.get("github.com/acme/bar"), 1);
});

test("a repo limited to one task only releases a single task per pass", () => {
  const { selected, blocked } = selectTasksWithinRepoLimits(
    [task("a", "https://github.com/acme/foo"), task("b", "https://github.com/acme/foo")],
    {
      limits: buildRepoConcurrencyLimits([
        { url: "https://github.com/acme/foo", maxConcurrentTasks: 1 },
      ]),
      running: new Map(),
      availableSlots: 5,
    },
  );

  assert.deepEqual(selected.map((t) => t.id), ["a"]);
  assert.deepEqual(blocked.map((b) => b.task.id), ["b"]);
  assert.equal(blocked[0].limit, 1);
  assert.equal(blocked[0].scope, "github.com/acme/foo");
});

test("a task already running against the repo consumes its slot", () => {
  const { selected, blocked } = selectTasksWithinRepoLimits([task("a", "https://github.com/acme/foo")], {
    limits: buildRepoConcurrencyLimits([
      { url: "https://github.com/acme/foo", maxConcurrentTasks: 1 },
    ]),
    running: countTasksPerRepo([task("running", "git@github.com:acme/foo.git")]),
    availableSlots: 5,
  });

  assert.deepEqual(selected, []);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].running, 1);
});

test("a blocked repo does not stall tasks queued behind it for other repos", () => {
  const { selected, blocked } = selectTasksWithinRepoLimits(
    [
      task("a", "https://github.com/acme/serial"),
      task("b", "https://github.com/acme/serial"),
      task("c", "https://github.com/acme/other"),
    ],
    {
      limits: buildRepoConcurrencyLimits([
        { url: "https://github.com/acme/serial", maxConcurrentTasks: 1 },
      ]),
      running: new Map(),
      availableSlots: 3,
    },
  );

  assert.deepEqual(selected.map((t) => t.id), ["a", "c"]);
  assert.deepEqual(blocked.map((b) => b.task.id), ["b"]);
});

test("a multi-repo task is blocked when any one of its repos is full", () => {
  const { selected, blocked } = selectTasksWithinRepoLimits(
    [task("a", "https://github.com/acme/free", "https://github.com/acme/busy")],
    {
      limits: buildRepoConcurrencyLimits([
        { url: "https://github.com/acme/busy", maxConcurrentTasks: 2 },
      ]),
      running: countTasksPerRepo([
        task("r1", "https://github.com/acme/busy"),
        task("r2", "https://github.com/acme/busy"),
      ]),
      availableSlots: 4,
    },
  );

  assert.deepEqual(selected, []);
  assert.equal(blocked[0].scope, "github.com/acme/busy");
});

test("repos without a limit are never blocked", () => {
  const { selected, blocked } = selectTasksWithinRepoLimits(
    [task("a", "https://github.com/acme/foo"), task("b", "https://github.com/acme/foo")],
    { limits: new Map(), running: new Map(), availableSlots: 4 },
  );

  assert.deepEqual(selected.map((t) => t.id), ["a", "b"]);
  assert.deepEqual(blocked, []);
});

test("the global slot count still caps the selection", () => {
  const { selected, blocked } = selectTasksWithinRepoLimits(
    [task("a", "https://github.com/acme/a"), task("b", "https://github.com/acme/b")],
    {
      limits: buildRepoConcurrencyLimits([
        { url: "https://github.com/acme/a", maxConcurrentTasks: 5 },
        { url: "https://github.com/acme/b", maxConcurrentTasks: 5 },
      ]),
      running: new Map(),
      availableSlots: 1,
    },
  );

  assert.deepEqual(selected.map((t) => t.id), ["a"]);
  // "next in line" is normal queueing, not a per-repo hold — don't report it.
  assert.deepEqual(blocked, []);
});

test("no free global slots selects nothing", () => {
  const { selected, blocked } = selectTasksWithinRepoLimits([task("a", "https://github.com/acme/a")], {
    limits: new Map(),
    running: new Map(),
    availableSlots: 0,
  });

  assert.deepEqual(selected, []);
  assert.deepEqual(blocked, []);
});

test("tasks with no repos are unaffected by repo limits", () => {
  const { selected } = selectTasksWithinRepoLimits([{ id: "a", repos: [] }], {
    limits: buildRepoConcurrencyLimits([
      { url: "https://github.com/acme/foo", maxConcurrentTasks: 1 },
    ]),
    running: countTasksPerRepo([task("r1", "https://github.com/acme/foo")]),
    availableSlots: 2,
  });

  assert.deepEqual(selected.map((t) => t.id), ["a"]);
});

test("repoLimitWaitMessage reads naturally for a serialized repo", () => {
  const message = repoLimitWaitMessage({
    task: { id: "a", repos: [] },
    scope: "github.com/acme/foo",
    limit: 1,
    running: 1,
  });

  assert.equal(
    message,
    "Waiting for a free slot on github.com/acme/foo: it allows 1 concurrent task and 1 is already running.",
  );
});
