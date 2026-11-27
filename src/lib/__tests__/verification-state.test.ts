/**
 * Unit tests for the verification ledger — the workspace-level record of which
 * build/lint/test runs already happened, used to stop a resumed task from
 * rebuilding and re-linting from scratch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildVerificationSection,
  computeWorkspaceState,
  extractVerificationCommands,
  flushVerificationWrites,
  readVerifications,
  recordCommandResult,
} from "../verification-state";

describe("extractVerificationCommands", () => {
  it("matches project-wide package scripts", () => {
    assert.deepEqual(extractVerificationCommands("npm run build"), ["npm run build"]);
    assert.deepEqual(extractVerificationCommands("npm run lint"), ["npm run lint"]);
    assert.deepEqual(extractVerificationCommands("pnpm run typecheck"), ["pnpm run typecheck"]);
    assert.deepEqual(extractVerificationCommands("yarn test"), ["yarn test"]);
  });

  it("unwraps a cd-and-run chain and records each check", () => {
    assert.deepEqual(
      extractVerificationCommands("cd /workspaces/abc/app && npm run lint && npm run build"),
      ["npm run lint", "npm run build"],
    );
  });

  it("strips env-var prefixes", () => {
    assert.deepEqual(extractVerificationCommands("CI=1 npm run build"), ["npm run build"]);
  });

  it("ignores commands that aren't project-wide checks", () => {
    assert.deepEqual(extractVerificationCommands("git status"), []);
    assert.deepEqual(extractVerificationCommands("ls -la"), []);
    assert.deepEqual(extractVerificationCommands("npm install"), []);
    assert.deepEqual(extractVerificationCommands("cat package.json"), []);
  });

  it("ignores checks scoped to specific files or paths", () => {
    assert.deepEqual(extractVerificationCommands("npx tsc --noEmit src/foo.ts"), []);
    assert.deepEqual(extractVerificationCommands("npx eslint src/lib/"), []);
    assert.deepEqual(extractVerificationCommands("npm run test -- src/lib/foo.test.ts"), []);
  });

  it("ignores watch-mode invocations", () => {
    assert.deepEqual(extractVerificationCommands("npm run test --watch"), []);
  });

  it("recognizes non-JS ecosystems", () => {
    assert.deepEqual(extractVerificationCommands("cargo clippy"), ["cargo clippy"]);
    assert.deepEqual(extractVerificationCommands("go test"), ["go test"]);
    assert.deepEqual(extractVerificationCommands("pytest"), ["pytest"]);
  });
});

function makeWorkspace(): { workspace: string; repo: string; cleanup: () => void } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "verif-state-"));
  const repo = path.join(workspace, "app");
  fs.mkdirSync(repo);
  const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "index.js"), "console.log(1);\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "init"]);
  return { workspace, repo, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

describe("workspace fingerprint", () => {
  it("is stable when nothing changes", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      const a = await computeWorkspaceState(workspace);
      const b = await computeWorkspaceState(workspace);
      assert.ok(a);
      assert.equal(a!.fingerprint, b!.fingerprint);
    } finally {
      cleanup();
    }
  });

  it("changes when a tracked file is edited", async () => {
    const { workspace, repo, cleanup } = makeWorkspace();
    try {
      const before = await computeWorkspaceState(workspace);
      fs.writeFileSync(path.join(repo, "index.js"), "console.log(2);\n");
      const after = await computeWorkspaceState(workspace);
      assert.notEqual(before!.fingerprint, after!.fingerprint);
    } finally {
      cleanup();
    }
  });

  it("changes when an untracked file's contents are edited", async () => {
    // Regression guard: `git diff` only covers tracked files, so a brand-new
    // file the agent is actively editing must still invalidate the ledger.
    const { workspace, repo, cleanup } = makeWorkspace();
    try {
      fs.writeFileSync(path.join(repo, "new.js"), "one\n");
      const before = await computeWorkspaceState(workspace);
      fs.writeFileSync(path.join(repo, "new.js"), "two\n");
      const after = await computeWorkspaceState(workspace);
      assert.notEqual(before!.fingerprint, after!.fingerprint);
    } finally {
      cleanup();
    }
  });

  it("returns null for a workspace with no repos", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verif-empty-"));
    try {
      assert.equal(await computeWorkspaceState(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recordCommandResult + buildVerificationSection", () => {
  it("tells the agent to skip a check that passed on an unchanged tree", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      recordCommandResult(workspace, "cd app && npm run build", true);
      await flushVerificationWrites();

      const entries = readVerifications(workspace);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].command, "npm run build");
      assert.equal(entries[0].status, "passed");

      const section = await buildVerificationSection(workspace);
      assert.match(section, /npm run build/);
      assert.match(section, /Do NOT run it again/);
    } finally {
      cleanup();
    }
  });

  it("downgrades to 're-run if affected' once the source changes", async () => {
    const { workspace, repo, cleanup } = makeWorkspace();
    try {
      recordCommandResult(workspace, "npm run build", true);
      await flushVerificationWrites();
      fs.writeFileSync(path.join(repo, "index.js"), "console.log(3);\n");

      const section = await buildVerificationSection(workspace);
      assert.match(section, /files have changed since/);
      assert.doesNotMatch(section, /Do NOT run it again/);
    } finally {
      cleanup();
    }
  });

  it("carries a failing check forward as outstanding work", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      recordCommandResult(workspace, "npm run lint", false);
      await flushVerificationWrites();

      const section = await buildVerificationSection(workspace);
      assert.match(section, /was FAILING/);
    } finally {
      cleanup();
    }
  });

  it("keeps only the latest outcome per command", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      recordCommandResult(workspace, "npm run lint", false);
      await flushVerificationWrites();
      recordCommandResult(workspace, "npm run lint", true);
      await flushVerificationWrites();

      const entries = readVerifications(workspace);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, "passed");
    } finally {
      cleanup();
    }
  });

  it("writes nothing for ordinary commands", async () => {
    const { workspace, cleanup } = makeWorkspace();
    try {
      recordCommandResult(workspace, "git status", true);
      await flushVerificationWrites();
      assert.deepEqual(readVerifications(workspace), []);
      assert.equal(await buildVerificationSection(workspace), "");
    } finally {
      cleanup();
    }
  });
});
