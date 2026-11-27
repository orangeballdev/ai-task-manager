/**
 * Unit tests for resolveRepoHadChanges — the logic that decides whether a task run
 * actually produced changes worth pushing/PR-ing.
 *
 * Regression coverage for a bug where tasks that pushed real commits (made by the
 * agent itself, mid-run) were reported as "no_changes" and never got a PR opened,
 * because commitAll()'s dirty-tree check alone doesn't see commits the agent already
 * made and committed before the worker's final commit step runs.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/git.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { SimpleGit } from "simple-git";
import { resolveRepoHadChanges, parseRemoteDefaultBranch, resolveBaseBranch, EMPTY_REPO_BASELINE } from "../git";

describe("resolveRepoHadChanges", () => {
  it("is true when the working tree was dirty at the final commit step", () => {
    assert.equal(resolveRepoHadChanges(true, "abc123", "abc123"), true);
  });

  it("is true when the agent already committed its own work, moving HEAD, even though the tree was clean at the final commit step", () => {
    // This is the regression case: dirtyTreeHadChanges is false (commitAll found
    // nothing left to commit) but HEAD moved since the run started, so there ARE
    // real commits on the branch that need to be pushed/PR'd.
    assert.equal(resolveRepoHadChanges(false, "base-sha", "agent-committed-sha"), true);
  });

  it("is false when nothing changed at all — tree clean and HEAD unchanged", () => {
    assert.equal(resolveRepoHadChanges(false, "same-sha", "same-sha"), false);
  });

  it("is false when the baseline sha could not be captured and the tree was clean", () => {
    // Falls back safely to "no changes" rather than guessing, matching prior behavior,
    // when we have no baseline to compare against.
    assert.equal(resolveRepoHadChanges(false, undefined, "some-sha"), false);
  });

  it("is false when the post-run sha could not be determined and the tree was clean", () => {
    assert.equal(resolveRepoHadChanges(false, "base-sha", undefined), false);
  });

  it("is true when the repo was empty before the run and the agent committed its first commits", () => {
    // Task cmwwng0yy: a freshly created GitHub repo with no branches; the agent made the
    // root commit itself, the worker pushed it, and the task still ended as no_changes.
    assert.equal(resolveRepoHadChanges(false, EMPTY_REPO_BASELINE, "root-commit-sha"), true);
  });

  it("is false when the repo was empty before the run and still has no commits", () => {
    assert.equal(resolveRepoHadChanges(false, EMPTY_REPO_BASELINE, undefined), false);
  });
});

describe("parseRemoteDefaultBranch", () => {
  it("reads the branch origin's HEAD points at", () => {
    const out = "ref: refs/heads/main\tHEAD\nf5e678c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7\tHEAD\n";
    assert.equal(parseRemoteDefaultBranch(out), "main");
  });

  it("keeps slashes in the branch name", () => {
    assert.equal(parseRemoteDefaultBranch("ref: refs/heads/release/v2\tHEAD\n"), "release/v2");
  });

  it("is null when there is no symref line", () => {
    assert.equal(parseRemoteDefaultBranch("f5e678c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7\tHEAD\n"), null);
    assert.equal(parseRemoteDefaultBranch(""), null);
  });
});

describe("resolveBaseBranch", () => {
  // Minimal stand-in for SimpleGit: answers `ls-remote` from a fixed set of remote branches.
  const fakeGit = (branches: string[], head: string | null, fail = false) => ({
    raw: async (args: string[]) => {
      if (fail) throw new Error("could not read from remote repository");
      if (args.includes("--symref")) return head ? `ref: refs/heads/${head}\tHEAD\nabc\tHEAD\n` : "abc\tHEAD\n";
      const pattern = args[args.length - 1];
      return branches
        .filter((b) => b === pattern || b.endsWith(`/${pattern}`))
        .map((b) => `abc\trefs/heads/${b}\n`).join("");
    },
  }) as unknown as SimpleGit;

  it("keeps the configured branch when origin has it", async () => {
    assert.equal(await resolveBaseBranch(fakeGit(["main", "develop"], "main"), "develop"), "develop");
  });

  it("falls back to origin's default branch when the configured one is missing", async () => {
    // The regression: global default 'develop' on a repo that only has 'main' — the PR
    // was never opened because everything compared against a branch that doesn't exist.
    assert.equal(await resolveBaseBranch(fakeGit(["main", "new-landing-page"], "main"), "develop"), "main");
  });

  it("doesn't mistake a suffix match for the branch itself", async () => {
    assert.equal(await resolveBaseBranch(fakeGit(["main", "feature/develop"], "main"), "develop"), "main");
  });

  it("returns the configured branch unchanged when origin can't be reached", async () => {
    assert.equal(await resolveBaseBranch(fakeGit([], null, true), "develop"), "develop");
  });

  it("returns the configured branch when origin reports no default", async () => {
    assert.equal(await resolveBaseBranch(fakeGit(["main"], null), "develop"), "develop");
  });
});

describe("syncWithBaseBranch / pullAndSyncWorkingRepo (real git repos)", async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { simpleGit } = await import("simple-git");
  const { syncWithBaseBranch, pullAndSyncWorkingRepo, safeEnv } = await import("../git");

  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim();

  /** origin (bare) with main + develop; a shallow workspace clone of develop on an agent branch. */
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctm-sync-"));
    const origin = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    const ws = path.join(root, "ws");
    fs.mkdirSync(seed);
    run(root, "init", "--bare", origin);
    run(seed, "init");
    fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
    run(seed, "add", ".");
    run(seed, "commit", "-m", "init");
    run(seed, "remote", "add", "origin", origin);
    run(seed, "push", "origin", "main");
    run(seed, "checkout", "-b", "develop");
    run(seed, "push", "origin", "develop");
    run(root, "clone", "--depth", "1", "--branch", "develop", `file://${origin}`, ws);
    run(ws, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    run(ws, "checkout", "-b", "agent/task");
    fs.writeFileSync(path.join(ws, "agent.txt"), "agent work\n");
    run(ws, "add", ".");
    run(ws, "commit", "-m", "agent work");
    /** Land a commit on origin/develop after the workspace was cloned. */
    const advanceDevelop = (file: string, content: string) => {
      fs.writeFileSync(path.join(seed, file), content);
      run(seed, "add", ".");
      run(seed, "commit", "-m", `upstream ${file}`);
      run(seed, "push", "origin", "develop");
    };
    const git = simpleGit(ws, { allowConfig: ["remote.origin.fetch"], allowEnvironment: ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] }).env({ ...safeEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
    return { root, ws, seed, git, advanceDevelop };
  }

  it("rebases an unpushed agent branch onto the latest base branch", async () => {
    const { root, ws, git, advanceDevelop } = setup();
    try {
      advanceDevelop("upstream.txt", "new on develop\n");
      const res = await pullAndSyncWorkingRepo(git, "agent/task", "develop");
      assert.equal(res.hadConflicts, false);
      assert.equal(res.baseConflict, false);
      assert.ok(fs.existsSync(path.join(ws, "upstream.txt")), "latest develop commit should be in the workspace");
      assert.ok(fs.existsSync(path.join(ws, "agent.txt")), "agent work should be kept");
      assert.match(res.message, /Rebased onto latest origin\/develop/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports already up to date when the base hasn't moved", async () => {
    const { root, git } = setup();
    try {
      const res = await syncWithBaseBranch(git, "develop");
      assert.deepEqual([res.updated, res.hadConflicts], [false, false]);
      assert.match(res.message, /Already up to date/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts on conflicts and leaves the branch untouched", async () => {
    const { root, ws, git, advanceDevelop } = setup();
    try {
      const before = run(ws, "rev-parse", "HEAD");
      advanceDevelop("agent.txt", "conflicting upstream content\n");
      const res = await syncWithBaseBranch(git, "develop");
      assert.equal(res.hadConflicts, true);
      assert.equal(res.updated, false);
      assert.equal(run(ws, "rev-parse", "HEAD"), before);
      assert.equal(run(ws, "status", "--porcelain"), "", "no rebase may be left in flight");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
