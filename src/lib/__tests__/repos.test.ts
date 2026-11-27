import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DuplicateRepoUrlError,
  excludeSavedRepos,
  getHiddenRecentRepoUrls,
  getRepoDefaultPriority,
  getSavedRepos,
  hideRecentRepo,
  removeSavedRepo,
  resolveDefaultPriorityForRepos,
  gitFieldsForMode,
  resolveRepoBranch,
  resolveRepoBranches,
  resolveRepoDefaults,
  upsertSavedRepo,
} from "../repos";

// In-memory stand-in for the Prisma `setting` model so these tests don't need
// a real database. Mirrors the minimal shape `SettingClient` expects.
function fakeClient() {
  const store = new Map<string, string>();
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = store.get(where.key);
        return value === undefined ? null : { value };
      },
      upsert: async ({ where, create }: { where: { key: string }; create?: unknown; update?: unknown }) => {
        const value = (create as { value: string } | undefined)?.value;
        if (value !== undefined) store.set(where.key, value);
        return {};
      },
    },
  };
}

test("removeSavedRepo drops a preset by url and leaves the rest untouched", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/b.git" }, client);

  const remaining = await removeSavedRepo("https://github.com/acme/a.git", client);

  assert.deepEqual(
    remaining.map((r) => r.url),
    ["https://github.com/acme/b.git"]
  );
  assert.deepEqual(
    (await getSavedRepos(client)).map((r) => r.url),
    ["https://github.com/acme/b.git"]
  );
});

test("removeSavedRepo is a no-op when the url isn't saved", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git" }, client);

  const remaining = await removeSavedRepo("https://github.com/acme/missing.git", client);

  assert.deepEqual(remaining.map((r) => r.url), ["https://github.com/acme/a.git"]);
});

test("hideRecentRepo dismisses a url from the recently-used list", async () => {
  const client = fakeClient();
  assert.deepEqual(await getHiddenRecentRepoUrls(client), []);

  const hidden = await hideRecentRepo("https://github.com/acme/c.git", client);

  assert.deepEqual(hidden, ["https://github.com/acme/c.git"]);
  assert.deepEqual(await getHiddenRecentRepoUrls(client), ["https://github.com/acme/c.git"]);
});

test("hideRecentRepo does not add duplicate entries", async () => {
  const client = fakeClient();
  await hideRecentRepo("https://github.com/acme/c.git", client);
  const hidden = await hideRecentRepo("https://github.com/acme/c.git", client);

  assert.deepEqual(hidden, ["https://github.com/acme/c.git"]);
});

test("hideRecentRepo ignores blank urls", async () => {
  const client = fakeClient();
  const hidden = await hideRecentRepo("   ", client);
  assert.deepEqual(hidden, []);
});

test("upsertSavedRepo stores and returns a valid default priority", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultPriority: "high" }, client);

  const repos = await getSavedRepos(client);
  assert.equal(repos[0].defaultPriority, "high");
  assert.equal(await getRepoDefaultPriority("https://github.com/acme/a.git", client), "high");
});

test("upsertSavedRepo ignores an invalid default priority", async () => {
  const client = fakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultPriority: "urgentish" as any }, client);

  const repos = await getSavedRepos(client);
  assert.equal(repos[0].defaultPriority, undefined);
});

test("upsertSavedRepo clears an existing default priority when passed null", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultPriority: "urgent" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultPriority: null }, client);

  const repos = await getSavedRepos(client);
  assert.equal(repos[0].defaultPriority, undefined);
});

test("upsertSavedRepo preserves default priority when the field isn't passed", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultPriority: "urgent" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", alias: "renamed" }, client);

  const repos = await getSavedRepos(client);
  assert.equal(repos[0].alias, "renamed");
  assert.equal(repos[0].defaultPriority, "urgent");
});

test("getRepoDefaultPriority matches urls by normalized scope", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "git@github.com:acme/a.git", defaultPriority: "low" }, client);

  assert.equal(await getRepoDefaultPriority("https://github.com/acme/a", client), "low");
  assert.equal(await getRepoDefaultPriority(undefined, client), undefined);
});

test("resolveDefaultPriorityForRepos picks the highest priority across multiple repos", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultPriority: "low" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/b.git", defaultPriority: "urgent" }, client);

  const resolved = await resolveDefaultPriorityForRepos(
    ["https://github.com/acme/a.git", "https://github.com/acme/b.git"],
    client
  );
  assert.equal(resolved, "urgent");
});

test("resolveDefaultPriorityForRepos returns undefined when no repo has a default set", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git" }, client);

  const resolved = await resolveDefaultPriorityForRepos(["https://github.com/acme/a.git"], client);
  assert.equal(resolved, undefined);
});

test("excludeSavedRepos drops a recent entry that's already saved", () => {
  const recent = [
    { url: "https://github.com/acme/a.git" },
    { url: "https://github.com/acme/b.git" },
  ];
  const saved = [{ url: "https://github.com/acme/a.git" }];

  const remaining = excludeSavedRepos(recent, saved);
  assert.deepEqual(remaining.map((r) => r.url), ["https://github.com/acme/b.git"]);
});

test("excludeSavedRepos matches by normalized scope, not exact string", () => {
  // Same repo, different forms: SSH vs HTTPS, trailing .git, credentials, host casing.
  const recent = [
    { url: "git@GitHub.com:acme/a.git" },
    { url: "https://user:pw@github.com/acme/a" },
    { url: "https://github.com/acme/b.git" },
  ];
  const saved = [{ url: "https://github.com/acme/a.git" }];

  const remaining = excludeSavedRepos(recent, saved);
  assert.deepEqual(remaining.map((r) => r.url), ["https://github.com/acme/b.git"]);
});

test("excludeSavedRepos is a no-op when nothing recent is saved", () => {
  const recent = [{ url: "https://github.com/acme/a.git" }];
  const saved: { url: string }[] = [];

  assert.deepEqual(excludeSavedRepos(recent, saved), recent);
});

test("upsertSavedRepo renames the clone URL when newUrl is passed, preserving other fields", async () => {
  const client = fakeClient();
  await upsertSavedRepo(
    { url: "https://github.com/acme/a.git", alias: "widgets", defaultPriority: "high" },
    client
  );

  const repos = await upsertSavedRepo(
    { url: "https://github.com/acme/a.git", newUrl: "https://github.com/acme/a-renamed.git" },
    client
  );

  assert.deepEqual(repos.map((r) => r.url), ["https://github.com/acme/a-renamed.git"]);
  assert.equal(repos[0].alias, "widgets");
  assert.equal(repos[0].defaultPriority, "high");
});

test("upsertSavedRepo rejects renaming onto a url another saved repo already uses", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/b.git" }, client);

  await assert.rejects(
    () =>
      upsertSavedRepo(
        { url: "https://github.com/acme/a.git", newUrl: "https://github.com/acme/b.git" },
        client
      ),
    DuplicateRepoUrlError
  );

  // Nothing should have changed (new presets are unshifted, so b — added
  // second — sorts first).
  assert.deepEqual(
    (await getSavedRepos(client)).map((r) => r.url),
    ["https://github.com/acme/b.git", "https://github.com/acme/a.git"]
  );
});

// --- Advanced-option defaults ------------------------------------------------

test("upsertSavedRepo stores the full set of advanced-option defaults", async () => {
  const client = fakeClient();
  await upsertSavedRepo(
    {
      url: "https://github.com/acme/a.git",
      defaultEffort: "high",
      defaultCostBudget: "2.50",
      defaultTokenBudget: 50000,
      defaultAiProviderId: "prov-1",
      defaultModel: "claude-sonnet-4-5",
      defaultLabels: ["Backend", " infra ", "backend"],
      defaultCreateValidationTask: true,
      defaultAllowSubtasks: true,
    },
    client
  );

  const [repo] = await getSavedRepos(client);
  assert.equal(repo.defaultEffort, "high");
  assert.equal(repo.defaultCostBudget, 2.5);
  assert.equal(repo.defaultTokenBudget, 50000);
  assert.equal(repo.defaultAiProviderId, "prov-1");
  assert.equal(repo.defaultModel, "claude-sonnet-4-5");
  // Labels are lower-cased, trimmed and de-duplicated.
  assert.deepEqual(repo.defaultLabels, ["backend", "infra"]);
  assert.equal(repo.defaultCreateValidationTask, true);
  assert.equal(repo.defaultAllowSubtasks, true);
});

test("upsertSavedRepo drops invalid or empty advanced defaults", async () => {
  const client = fakeClient();
  await upsertSavedRepo(
    {
      url: "https://github.com/acme/a.git",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defaultEffort: "titanic" as any,
      defaultCostBudget: "not-a-number",
      defaultTokenBudget: -5,
      defaultModel: "   ",
      defaultLabels: [],
      defaultCreateValidationTask: false,
      defaultAllowSubtasks: false,
    },
    client
  );

  const [repo] = await getSavedRepos(client);
  assert.equal(repo.defaultEffort, undefined);
  assert.equal(repo.defaultCostBudget, undefined);
  assert.equal(repo.defaultTokenBudget, undefined);
  assert.equal(repo.defaultModel, undefined);
  assert.equal(repo.defaultLabels, undefined);
  assert.equal(repo.defaultCreateValidationTask, undefined);
  assert.equal(repo.defaultAllowSubtasks, undefined);
});

test("upsertSavedRepo clears advanced defaults passed as null but keeps omitted ones", async () => {
  const client = fakeClient();
  await upsertSavedRepo(
    {
      url: "https://github.com/acme/a.git",
      defaultEffort: "max",
      defaultCostBudget: 3,
      defaultModel: "claude-opus-4-1",
    },
    client
  );

  await upsertSavedRepo(
    { url: "https://github.com/acme/a.git", defaultCostBudget: null },
    client
  );

  const [repo] = await getSavedRepos(client);
  assert.equal(repo.defaultCostBudget, undefined);
  assert.equal(repo.defaultEffort, "max");
  assert.equal(repo.defaultModel, "claude-opus-4-1");
});

test("upsertSavedRepo keeps Smart Provider and a pinned provider mutually exclusive", async () => {
  const client = fakeClient();
  await upsertSavedRepo(
    { url: "https://github.com/acme/a.git", defaultUseSmartProvider: true },
    client
  );
  assert.equal((await getSavedRepos(client))[0].defaultAiProviderId, undefined);
  assert.equal((await getSavedRepos(client))[0].defaultUseSmartProvider, true);

  // Pinning a provider afterwards turns Smart Provider back off.
  await upsertSavedRepo(
    { url: "https://github.com/acme/a.git", defaultAiProviderId: "prov-2" },
    client
  );
  const [repo] = await getSavedRepos(client);
  assert.equal(repo.defaultAiProviderId, "prov-2");
  assert.equal(repo.defaultUseSmartProvider, undefined);
});

test("resolveRepoDefaults returns the defaults of a matching repo", async () => {
  const client = fakeClient();
  await upsertSavedRepo(
    {
      url: "git@github.com:acme/a.git",
      defaultEffort: "low",
      defaultCostBudget: 1.25,
      defaultLabels: ["infra"],
    },
    client
  );

  // Matched by normalized scope, so a different url form still resolves.
  const resolved = await resolveRepoDefaults(["https://github.com/acme/a"], client);
  assert.equal(resolved.defaultEffort, "low");
  assert.equal(resolved.defaultCostBudget, 1.25);
  assert.deepEqual(resolved.defaultLabels, ["infra"]);
});

test("resolveRepoDefaults lets the first repo win, but takes the highest priority and all labels", async () => {
  const client = fakeClient();
  await upsertSavedRepo(
    {
      url: "https://github.com/acme/a.git",
      defaultPriority: "low",
      defaultModel: "model-a",
      defaultLabels: ["a"],
    },
    client
  );
  await upsertSavedRepo(
    {
      url: "https://github.com/acme/b.git",
      defaultPriority: "urgent",
      defaultModel: "model-b",
      defaultEffort: "high",
      defaultLabels: ["b"],
    },
    client
  );

  const resolved = await resolveRepoDefaults(
    ["https://github.com/acme/a.git", "https://github.com/acme/b.git"],
    client
  );
  assert.equal(resolved.defaultPriority, "urgent");
  // First repo listed wins for single-valued options...
  assert.equal(resolved.defaultModel, "model-a");
  // ...but options only the second repo sets are still inherited.
  assert.equal(resolved.defaultEffort, "high");
  assert.deepEqual(resolved.defaultLabels, ["a", "b"]);
});

test("resolveRepoDefaults returns nothing for unsaved repos", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultEffort: "high" }, client);

  assert.deepEqual(await resolveRepoDefaults(["https://github.com/acme/other.git"], client), {});
  assert.deepEqual(await resolveRepoDefaults([undefined, null], client), {});
});

test("maxConcurrentTasks round-trips and only accepts positive integers", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", maxConcurrentTasks: 1 }, client);
  // Strings arrive this way from the JSON body of a form submit.
  await upsertSavedRepo({ url: "https://github.com/acme/b.git", maxConcurrentTasks: "3" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/c.git", maxConcurrentTasks: 0 }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/d.git", maxConcurrentTasks: "nope" }, client);

  const byUrl = new Map((await getSavedRepos(client)).map((r) => [r.url, r]));
  assert.equal(byUrl.get("https://github.com/acme/a.git")?.maxConcurrentTasks, 1);
  assert.equal(byUrl.get("https://github.com/acme/b.git")?.maxConcurrentTasks, 3);
  assert.equal(byUrl.get("https://github.com/acme/c.git")?.maxConcurrentTasks, undefined);
  assert.equal(byUrl.get("https://github.com/acme/d.git")?.maxConcurrentTasks, undefined);
});

test("maxConcurrentTasks survives an unrelated update and clears on null", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", maxConcurrentTasks: 2 }, client);

  // A save that doesn't mention the cap must leave it alone.
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultEffort: "high" }, client);
  let repos = await getSavedRepos(client);
  assert.equal(repos[0].maxConcurrentTasks, 2);
  assert.equal(repos[0].defaultEffort, "high");

  // ...but an explicit null (an emptied input) clears it.
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", maxConcurrentTasks: null }, client);
  repos = await getSavedRepos(client);
  assert.equal(repos[0].maxConcurrentTasks, undefined);
  assert.equal(repos[0].defaultEffort, "high");
});

test("maxConcurrentTasks follows a repo through a clone-url rename", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", maxConcurrentTasks: 1 }, client);
  await upsertSavedRepo(
    { url: "https://github.com/acme/a.git", newUrl: "https://github.com/acme/moved.git" },
    client,
  );

  const repos = await getSavedRepos(client);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].url, "https://github.com/acme/moved.git");
  assert.equal(repos[0].maxConcurrentTasks, 1);
});

test("upsertSavedRepo stores git defaults and clears them with null", async () => {
  const client = fakeClient();
  const url = "https://github.com/acme/a.git";
  await upsertSavedRepo({ url, defaultBranch: " develop ", defaultGitMode: "target", defaultTargetBranch: "staging" }, client);
  let [repo] = await getSavedRepos(client);
  assert.equal(repo.defaultBranch, "develop");
  assert.equal(repo.defaultGitMode, "target");
  assert.equal(repo.defaultTargetBranch, "staging");

  // Switching away from "target" drops the now-meaningless target branch.
  await upsertSavedRepo({ url, defaultGitMode: "pr" }, client);
  [repo] = await getSavedRepos(client);
  assert.equal(repo.defaultGitMode, "pr");
  assert.equal(repo.defaultTargetBranch, undefined);
  assert.equal(repo.defaultBranch, "develop");

  await upsertSavedRepo({ url, defaultBranch: null, defaultGitMode: null }, client);
  [repo] = await getSavedRepos(client);
  assert.equal(repo.defaultBranch, undefined);
  assert.equal(repo.defaultGitMode, undefined);
});

test("upsertSavedRepo rejects an invalid git mode and 'target' without a branch", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultGitMode: "yolo" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/b.git", defaultGitMode: "target" }, client);
  for (const repo of await getSavedRepos(client)) {
    assert.equal(repo.defaultGitMode, undefined);
    assert.equal(repo.defaultTargetBranch, undefined);
  }
});

test("resolveRepoDefaults takes the git mode and target branch together from the first repo with one", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultBranch: "develop" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/b.git", defaultGitMode: "target", defaultTargetBranch: "qa" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/c.git", defaultGitMode: "main" }, client);
  const resolved = await resolveRepoDefaults(
    ["git@github.com:acme/a.git", "https://github.com/acme/b", "https://github.com/acme/c"],
    client,
  );
  assert.equal(resolved.defaultGitMode, "target");
  assert.equal(resolved.defaultTargetBranch, "qa");
  // The branch is per repo, never merged onto the task.
  assert.equal(resolved.defaultBranch, undefined);
});

test("resolveRepoBranches fills each repo's own default branch unless one was passed", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git", defaultBranch: "develop" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/b.git", defaultBranch: "trunk" }, client);
  const out = await resolveRepoBranches(
    [
      { url: "git@github.com:acme/a.git" },
      { url: "https://github.com/acme/b", branch: "feature-x" },
      { url: "https://github.com/acme/b", branch: "  " },
      { url: "https://github.com/acme/unsaved.git" },
    ],
    client,
  );
  assert.deepEqual(out.map((r) => r.branch), ["develop", "feature-x", "trunk", null]);
});

test("resolveRepoBranch and gitFieldsForMode map onto task columns", () => {
  assert.equal(resolveRepoBranch(undefined, "develop"), "develop");
  assert.equal(resolveRepoBranch("main", "develop"), "main");
  assert.equal(resolveRepoBranch(null, undefined), null);
  assert.deepEqual(gitFieldsForMode("pr"), { pushToMain: false, createPR: true, targetBranch: null });
  assert.deepEqual(gitFieldsForMode("main"), { pushToMain: true, createPR: false, targetBranch: null });
  assert.deepEqual(gitFieldsForMode("branch", "x"), { pushToMain: false, createPR: false, targetBranch: null });
  assert.deepEqual(gitFieldsForMode("target", " qa "), { pushToMain: false, createPR: false, targetBranch: "qa" });
});

test("upsertSavedRepo stores, keeps and clears a default team", async () => {
  const client = fakeClient();
  const url = "https://github.com/acme/a.git";
  await upsertSavedRepo({ url, defaultTeamId: " team-1 " }, client);
  assert.equal((await getSavedRepos(client))[0].defaultTeamId, "team-1");

  // Omitted = untouched.
  await upsertSavedRepo({ url, defaultEffort: "high" }, client);
  assert.equal((await getSavedRepos(client))[0].defaultTeamId, "team-1");

  // null / "" = cleared.
  await upsertSavedRepo({ url, defaultTeamId: null }, client);
  assert.equal((await getSavedRepos(client))[0].defaultTeamId, undefined);
  await upsertSavedRepo({ url, defaultTeamId: "team-2" }, client);
  await upsertSavedRepo({ url, defaultTeamId: "" }, client);
  assert.equal((await getSavedRepos(client))[0].defaultTeamId, undefined);
});

test("resolveRepoDefaults takes the default team from the first repo that has one", async () => {
  const client = fakeClient();
  await upsertSavedRepo({ url: "https://github.com/acme/a.git" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/b.git", defaultTeamId: "team-b" }, client);
  await upsertSavedRepo({ url: "https://github.com/acme/c.git", defaultTeamId: "team-c" }, client);

  const resolved = await resolveRepoDefaults(
    ["https://github.com/acme/a.git", "git@github.com:acme/c.git", "https://github.com/acme/b.git"],
    client
  );
  assert.equal(resolved.defaultTeamId, "team-c");
  assert.equal((await resolveRepoDefaults(["https://github.com/acme/a.git"], client)).defaultTeamId, undefined);
});
