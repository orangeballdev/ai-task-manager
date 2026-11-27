/**
 * Saved repository presets.
 *
 * The app lets users save the Git repos they work with so they show up as
 * quick-pick options on the new-task form. Each saved repo can also carry a
 * **default context** — freeform instructions (markdown/plain text) that are
 * automatically injected into every task run against that repo and prefilled
 * into the new-task form's Context field.
 *
 * This replaces the old per-entry "Knowledge library" concept: instead of
 * curating typed/tagged knowledge entries, you keep a short, human-editable
 * note per repo that always travels with tasks for that repo.
 *
 * Presets are stored as a single JSON blob in the `saved_repo_presets`
 * Setting row so no schema migration is required.
 *
 * Each saved repo can also carry **advanced-option defaults** — the same
 * settings the new-task form exposes under "Advanced Options" (priority,
 * effort, cost/token budget, AI provider, model, labels, follow-up validation
 * task). When set, any task created against that repo (from the new-task form,
 * or headless via the API, webhooks, inbound email, or Slack) inherits them
 * unless the caller explicitly picks its own value — an explicitly chosen
 * option always wins over the repo's default. This lets e.g. a customer-facing
 * repo's tasks consistently jump ahead of a low-stakes internal repo's tasks
 * in the worker's pick-up order (see src/lib/priority.ts), or a heavy repo
 * always run on a bigger model.
 *
 * Separately from those defaults, a saved repo can cap how many of its tasks
 * run **concurrently** (`maxConcurrentTasks`) — useful when parallel agents on
 * the same repo would trip over shared state. That cap is enforced by the
 * worker at pick-up time rather than copied onto tasks; see
 * src/lib/repo-concurrency.ts.
 *
 * Finally, a saved repo can carry **git defaults**: the branch tasks clone it
 * at (`defaultBranch`) and what happens to the work once the task completes
 * (`defaultGitMode` — push to an agent branch, push to a named branch, push to
 * the base branch, or open a PR — plus `defaultTargetBranch` for "push to a
 * named branch"). Like the advanced-option defaults they only fill in what the
 * caller left out; see {@link resolveRepoBranch} and {@link gitFieldsForMode}.
 */

import { prisma } from "./db";
import { normalizeScope } from "./knowledge";
import { isTaskPriority, priorityWeight, type TaskPriority } from "./priority";
import { isTaskEffort, type TaskEffort } from "./effort";

/**
 * What happens to the agent's work once a task completes — the "After task
 * completes" section of the new-task form. Maps onto the Task columns as:
 *
 * - `branch` — push to a fresh agent branch (no PR)
 * - `target` — push to an existing, named branch (`targetBranch`)
 * - `main`   — push directly to the base branch (`pushToMain`)
 * - `pr`     — push to an agent branch and open a PR (`createPR`)
 */
export type RepoGitMode = "branch" | "target" | "main" | "pr";

export const REPO_GIT_MODES: readonly RepoGitMode[] = ["branch", "target", "main", "pr"];

export function isRepoGitMode(v: unknown): v is RepoGitMode {
  return typeof v === "string" && (REPO_GIT_MODES as readonly string[]).includes(v);
}

/**
 * The Task columns a git mode stands for. `targetBranch` is only meaningful
 * (and only returned non-null) for `target`.
 */
export function gitFieldsForMode(
  mode: RepoGitMode,
  targetBranch?: string | null,
): { pushToMain: boolean; createPR: boolean; targetBranch: string | null } {
  return {
    pushToMain: mode === "main",
    createPR: mode === "pr",
    targetBranch: mode === "target" ? targetBranch?.trim() || null : null,
  };
}

export const SAVED_REPOS_SETTING_KEY = "saved_repo_presets";

// Urls the user has explicitly dismissed from the "Recently used" list on the
// repositories page. This never touches TaskRepo history (each row belongs to
// a real past task) — it's purely a display-side filter, so removing a repo
// here doesn't affect any existing task.
export const HIDDEN_RECENT_REPOS_SETTING_KEY = "hidden_recent_repos";

/**
 * Per-repo defaults for the task fields the new-task form groups under
 * "Advanced Options". Every field is optional: `undefined` means "this repo
 * has no opinion, use the system default".
 */
export interface RepoTaskDefaults {
  /** Default context injected into tasks for this repo. */
  defaultContext?: string;
  /** Queue priority for tasks created against this repo. */
  defaultPriority?: TaskPriority;
  /** Thinking effort (`--effort`) for tasks created against this repo. */
  defaultEffort?: TaskEffort;
  /** Max spend in USD before the agent commits and stops. */
  defaultCostBudget?: number;
  /** Max total tokens before the agent commits and stops. */
  defaultTokenBudget?: number;
  /** AI provider that should run tasks for this repo. */
  defaultAiProviderId?: string;
  /** Whether tasks for this repo use Smart Provider selection. */
  defaultUseSmartProvider?: boolean;
  /** Pinned model id for tasks against this repo. */
  defaultModel?: string;
  /** Labels applied to every task created against this repo. */
  defaultLabels?: string[];
  /** Whether to spawn a follow-up validation task once the task completes. */
  defaultCreateValidationTask?: boolean;
  /**
   * Branch tasks clone this repo at (and base agent branches / PRs on). Absent
   * = the global default from Settings → Git. Per-repo: unlike the other
   * defaults it is never merged across a task's repos — each repo of a task
   * gets its own (see {@link resolveRepoBranch}).
   */
  defaultBranch?: string;
  /** "After task completes" behaviour for tasks created against this repo. */
  defaultGitMode?: RepoGitMode;
  /** Branch to push to when `defaultGitMode` is `target` (required then). */
  defaultTargetBranch?: string;
  /** Whether the agent may queue subtasks of its own (see src/lib/subtasks.ts). */
  defaultAllowSubtasks?: boolean;
  /**
   * Team (`Team.id`) that runs tasks created against this repo as a pipeline
   * instead of a single agent. Absent = single agent. A team deleted after it
   * was saved here is ignored at task creation (see `existingTeamId()` in
   * src/lib/teams.ts) rather than failing the task.
   */
  defaultTeamId?: string;
}

export interface SavedRepo extends RepoTaskDefaults {
  url: string;
  alias: string;
  /**
   * Max number of tasks the worker may run **at the same time** against this
   * repo. `undefined` means unlimited (only the global `concurrent_tasks`
   * setting applies). Set it to 1 for repos where parallel agents would fight
   * over shared state, migrations, or the same branch.
   *
   * Unlike the `default*` fields this is not a task default — it's never
   * copied onto a task at creation time. It's enforced by the worker every
   * poll cycle (see src/lib/repo-concurrency.ts), so changing it takes effect
   * for tasks that are already queued.
   */
  maxConcurrentTasks?: number;
}

// Minimal prisma-like shape so the worker or tests can inject a client without
// a hard dependency on the generated client type.
type SettingArgs = { where: { key: string }; create?: unknown; update?: unknown };
type SettingClient = {
  setting: {
    findUnique: (args: SettingArgs) => Promise<{ value: string } | null>;
    upsert: (args: SettingArgs) => Promise<unknown>;
  };
};

/** Positive finite number, or undefined for anything else (incl. "", null, 0). */
function normalizeBudget(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Positive integer >= 1, or undefined for anything else (incl. "", null, 0,
 * negatives and fractions). Undefined means "no concurrency cap for this repo".
 */
export function normalizeMaxConcurrentTasks(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  return i >= 1 ? i : undefined;
}

function normalizeText(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function normalizeFlag(v: unknown): true | undefined {
  // Only `true` is stored — `false` is identical to "no default", and keeping
  // the key out of the JSON keeps presets small and diffable.
  return v === true || v === "true" ? true : undefined;
}

function normalizeLabels(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const labels = Array.from(
    new Set(
      v
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean)
    )
  );
  return labels.length > 0 ? labels : undefined;
}

/**
 * Coerce arbitrary (user/API supplied or previously persisted) values into a
 * valid {@link RepoTaskDefaults}. Anything invalid, empty or "same as the
 * system default" collapses to `undefined`, i.e. "this repo has no default".
 */
function normalizeDefaults(rec: Record<string, unknown>): RepoTaskDefaults {
  const defaults: RepoTaskDefaults = {
    defaultContext:
      typeof rec.defaultContext === "string" && rec.defaultContext.trim()
        ? rec.defaultContext
        : undefined,
    defaultPriority: isTaskPriority(rec.defaultPriority) ? rec.defaultPriority : undefined,
    defaultEffort: isTaskEffort(rec.defaultEffort) ? rec.defaultEffort : undefined,
    defaultCostBudget: normalizeBudget(rec.defaultCostBudget),
    defaultTokenBudget: normalizeBudget(rec.defaultTokenBudget),
    defaultAiProviderId: normalizeText(rec.defaultAiProviderId),
    defaultUseSmartProvider: normalizeFlag(rec.defaultUseSmartProvider),
    defaultModel: normalizeText(rec.defaultModel),
    defaultLabels: normalizeLabels(rec.defaultLabels),
    defaultCreateValidationTask: normalizeFlag(rec.defaultCreateValidationTask),
    defaultBranch: normalizeText(rec.defaultBranch),
    defaultGitMode: isRepoGitMode(rec.defaultGitMode) ? rec.defaultGitMode : undefined,
    defaultTargetBranch: normalizeText(rec.defaultTargetBranch),
    defaultAllowSubtasks: normalizeFlag(rec.defaultAllowSubtasks),
    defaultTeamId: normalizeText(rec.defaultTeamId),
  };
  // A target branch only means something for "push to branch", and "push to
  // branch" means nothing without one — so neither survives without the other.
  if (defaults.defaultGitMode !== "target") defaults.defaultTargetBranch = undefined;
  else if (!defaults.defaultTargetBranch) defaults.defaultGitMode = undefined;
  // Smart Provider and a pinned provider are mutually exclusive — the same rule
  // POST /api/tasks applies (`aiProviderId: useSmartProvider ? null : …`).
  if (defaults.defaultUseSmartProvider) defaults.defaultAiProviderId = undefined;
  return defaults;
}

/** Strip `undefined` entries so unset defaults never reach the stored JSON. */
function compact(defaults: RepoTaskDefaults): RepoTaskDefaults {
  return Object.fromEntries(
    Object.entries(defaults).filter(([, v]) => v !== undefined)
  ) as RepoTaskDefaults;
}

function sanitize(raw: unknown): SavedRepo[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedRepo[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!url) continue;
    const alias =
      typeof rec.alias === "string" && rec.alias.trim()
        ? rec.alias.trim()
        : deriveAlias(url);
    const maxConcurrentTasks = normalizeMaxConcurrentTasks(rec.maxConcurrentTasks);
    out.push({
      url,
      alias,
      ...compact(normalizeDefaults(rec)),
      ...(maxConcurrentTasks !== undefined ? { maxConcurrentTasks } : {}),
    });
  }
  return out;
}

export function deriveAlias(url: string): string {
  return (
    url
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") || "repo"
  );
}

/**
 * Drop entries from a "recently used" repo list that are already saved, so
 * the Repositories page doesn't show the same repo twice. Matches by
 * `normalizeScope()` rather than exact string equality, so a recent repo
 * whose `TaskRepo.url` differs cosmetically from its saved preset (SSH vs
 * HTTPS, trailing `.git`, embedded credentials, host casing) is still
 * recognized as a duplicate and excluded.
 */
export function excludeSavedRepos<T extends { url: string }>(
  recentRepos: T[],
  savedRepos: Pick<SavedRepo, "url">[],
): T[] {
  const savedScopes = new Set(savedRepos.map((r) => normalizeScope(r.url)));
  return recentRepos.filter((r) => !savedScopes.has(normalizeScope(r.url)));
}

export async function getSavedRepos(
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<SavedRepo[]> {
  try {
    const setting = await client.setting.findUnique({
      where: { key: SAVED_REPOS_SETTING_KEY },
    });
    if (!setting?.value) return [];
    return sanitize(JSON.parse(setting.value));
  } catch {
    return [];
  }
}

export async function setSavedRepos(
  repos: SavedRepo[],
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<void> {
  const value = JSON.stringify(sanitize(repos));
  await client.setting.upsert({
    where: { key: SAVED_REPOS_SETTING_KEY },
    create: { key: SAVED_REPOS_SETTING_KEY, value },
    update: { value },
  });
}

/**
 * Loose, over-the-wire shape of {@link RepoTaskDefaults} as it arrives from the
 * Repositories page / API. Each key is tri-state:
 *
 * - `undefined` — the caller didn't touch this field; keep whatever is stored.
 * - `null` / `""` / an invalid value — explicitly clear the default.
 * - a valid value — set the default.
 */
export interface RepoDefaultsInput {
  defaultContext?: string | null;
  defaultPriority?: string | null;
  defaultEffort?: string | null;
  defaultCostBudget?: number | string | null;
  defaultTokenBudget?: number | string | null;
  defaultAiProviderId?: string | null;
  defaultUseSmartProvider?: boolean | null;
  defaultModel?: string | null;
  defaultLabels?: string[] | null;
  defaultCreateValidationTask?: boolean | null;
  defaultBranch?: string | null;
  defaultGitMode?: string | null;
  defaultTargetBranch?: string | null;
  defaultAllowSubtasks?: boolean | null;
  defaultTeamId?: string | null;
}

/**
 * Repo-level settings that aren't task defaults. Same tri-state convention as
 * {@link RepoDefaultsInput}: `undefined` keeps the stored value, `null`/`""`
 * clears it, a valid value sets it.
 */
export interface RepoSettingsInput extends RepoDefaultsInput {
  maxConcurrentTasks?: number | string | null;
}

const DEFAULT_KEYS = [
  "defaultContext",
  "defaultPriority",
  "defaultEffort",
  "defaultCostBudget",
  "defaultTokenBudget",
  "defaultAiProviderId",
  "defaultUseSmartProvider",
  "defaultModel",
  "defaultLabels",
  "defaultCreateValidationTask",
  "defaultBranch",
  "defaultGitMode",
  "defaultTargetBranch",
  "defaultAllowSubtasks",
  "defaultTeamId",
] as const satisfies readonly (keyof RepoTaskDefaults)[];

/**
 * Apply a partial update to a repo's stored defaults. Keys the caller left
 * `undefined` keep their existing value; everything else is re-normalized,
 * which is what turns `null`/`""` into "cleared".
 */
function mergeDefaults(existing: RepoTaskDefaults, input: RepoDefaultsInput): RepoTaskDefaults {
  const raw: Record<string, unknown> = {};
  for (const key of DEFAULT_KEYS) {
    raw[key] = input[key] !== undefined ? input[key] : existing[key];
  }
  // Pinning a provider implicitly turns Smart Provider off (they're mutually
  // exclusive), so a caller that only sends defaultAiProviderId still gets the
  // result it obviously meant.
  if (input.defaultUseSmartProvider === undefined && normalizeText(input.defaultAiProviderId)) {
    raw.defaultUseSmartProvider = false;
  }
  return normalizeDefaults(raw);
}

// Thrown by upsertSavedRepo when a rename (`newUrl`) would collide with a
// different, already-saved repo's clone URL. Callers (the API route) turn
// this into a 409 instead of silently merging two presets together.
export class DuplicateRepoUrlError extends Error {
  constructor(public readonly url: string) {
    super(`A saved repository already uses the clone URL "${url}"`);
    this.name = "DuplicateRepoUrlError";
  }
}

/**
 * Insert or update a saved repo (matched by exact URL, or `newUrl` when
 * renaming — see below). Fields left undefined are preserved from the
 * existing preset when one is present.
 */
export async function upsertSavedRepo(
  input: {
    url: string;
    /**
     * When present and different from `url`, updates the saved repo's clone
     * URL itself (e.g. the remote moved, or the original entry had a typo).
     * `url` is still used to locate the existing preset; `newUrl` becomes its
     * new key. Throws {@link DuplicateRepoUrlError} if another saved repo
     * already uses `newUrl`.
     */
    newUrl?: string;
    alias?: string;
  } & RepoSettingsInput,
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<SavedRepo[]> {
  const url = input.url.trim();
  if (!url) return getSavedRepos(client);
  const repos = await getSavedRepos(client);
  const idx = repos.findIndex((r) => r.url === url);
  const targetUrl = input.newUrl?.trim() || url;

  if (targetUrl !== url && repos.some((r) => r.url === targetUrl)) {
    throw new DuplicateRepoUrlError(targetUrl);
  }

  // `undefined` = "caller didn't touch it" (keep whatever is stored), anything
  // else is re-normalized so null/""/0 clear the cap.
  const mergeConcurrency = (existing: number | undefined) =>
    input.maxConcurrentTasks === undefined
      ? existing
      : normalizeMaxConcurrentTasks(input.maxConcurrentTasks);

  if (idx === -1) {
    const maxConcurrentTasks = mergeConcurrency(undefined);
    repos.unshift({
      url: targetUrl,
      alias: input.alias?.trim() || deriveAlias(targetUrl),
      ...compact(mergeDefaults({}, input)),
      ...(maxConcurrentTasks !== undefined ? { maxConcurrentTasks } : {}),
    });
  } else {
    const existing = repos[idx];
    const maxConcurrentTasks = mergeConcurrency(existing.maxConcurrentTasks);
    repos[idx] = {
      url: targetUrl,
      alias: input.alias !== undefined ? input.alias.trim() || existing.alias : existing.alias,
      ...compact(mergeDefaults(existing, input)),
      ...(maxConcurrentTasks !== undefined ? { maxConcurrentTasks } : {}),
    };
  }
  await setSavedRepos(repos, client);
  return repos;
}

export async function removeSavedRepo(
  url: string,
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<SavedRepo[]> {
  const repos = await getSavedRepos(client);
  const updated = repos.filter((r) => r.url !== url);
  await setSavedRepos(updated, client);
  return updated;
}

function sanitizeUrlList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r === "string" && r.trim()) out.push(r.trim());
  }
  return out;
}

export async function getHiddenRecentRepoUrls(
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<string[]> {
  try {
    const setting = await client.setting.findUnique({
      where: { key: HIDDEN_RECENT_REPOS_SETTING_KEY },
    });
    if (!setting?.value) return [];
    return sanitizeUrlList(JSON.parse(setting.value));
  } catch {
    return [];
  }
}

/**
 * Dismiss a url from the "Recently used" list on the repositories page. Purely
 * cosmetic — the underlying TaskRepo rows (and the tasks that reference them)
 * are untouched. If the same url is used by a future task it stays hidden
 * from the quick-pick list until removed from this list.
 */
export async function hideRecentRepo(
  url: string,
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<string[]> {
  const trimmed = url.trim();
  if (!trimmed) return getHiddenRecentRepoUrls(client);
  const hidden = await getHiddenRecentRepoUrls(client);
  if (hidden.includes(trimmed)) return hidden;
  const updated = [...hidden, trimmed];
  const value = JSON.stringify(updated);
  await client.setting.upsert({
    where: { key: HIDDEN_RECENT_REPOS_SETTING_KEY },
    create: { key: HIDDEN_RECENT_REPOS_SETTING_KEY, value },
    update: { value },
  });
  return updated;
}

/**
 * Look up the default context for a repo URL. Matches by normalized scope so
 * `git@github.com:acme/foo.git` and `https://github.com/acme/foo` resolve to
 * the same preset. Returns undefined when no matching preset (or no context)
 * exists.
 */
export async function getRepoDefaultContext(
  url: string | null | undefined,
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<string | undefined> {
  if (!url) return undefined;
  const target = normalizeScope(url);
  const repos = await getSavedRepos(client);
  const match = repos.find((r) => normalizeScope(r.url) === target);
  const ctx = match?.defaultContext?.trim();
  return ctx || undefined;
}

/**
 * Look up the default priority for a single repo URL (matched by normalized
 * scope, same as {@link getRepoDefaultContext}). Returns undefined when the
 * repo isn't saved or has no default priority set.
 */
export async function getRepoDefaultPriority(
  url: string | null | undefined,
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<TaskPriority | undefined> {
  if (!url) return undefined;
  const target = normalizeScope(url);
  const repos = await getSavedRepos(client);
  const match = repos.find((r) => normalizeScope(r.url) === target);
  return match?.defaultPriority;
}

/**
 * Resolve the advanced-option defaults to use for a task spanning one or more
 * repos, matched by normalized scope (see {@link getRepoDefaultContext}).
 *
 * When several of the task's repos define the same default, the winner is:
 *
 * - **priority** — the highest one. A task touching both a low-priority and a
 *   high-priority repo should still be queued as high-priority, since that's
 *   the repo whose maintainers most want it run promptly.
 * - **labels** — the union, so a task inherits every repo's tags.
 * - **git mode** — the first repo with one, together with *its* target
 *   branch (the pair is never split across repos).
 * - **team** — the first repo with one (falls under "everything else").
 * - **branch** — never resolved here: it's per-repo, see {@link resolveRepoBranch}.
 * - **everything else** — the first repo (in the order the urls were passed,
 *   i.e. the task's primary repo first) that has a default for it.
 *
 * Fields no repo has configured come back `undefined`, so callers can fall
 * back to the system default.
 */
export async function resolveRepoDefaults(
  urls: (string | null | undefined)[],
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<RepoTaskDefaults> {
  const repos = await getSavedRepos(client);
  if (repos.length === 0) return {};
  const targets = urls.filter((u): u is string => Boolean(u)).map((u) => normalizeScope(u));
  if (targets.length === 0) return {};

  // Walk the repos in the order they were passed in so "first one wins" means
  // "the task's primary repo wins", not "whichever was saved first".
  const byScope = new Map(repos.map((r) => [normalizeScope(r.url), r]));
  const matched = targets
    .map((t) => byScope.get(t))
    .filter((r): r is SavedRepo => Boolean(r));

  const resolved: RepoTaskDefaults = {};
  for (const repo of matched) {
    for (const key of DEFAULT_KEYS) {
      if (repo[key] === undefined) continue;
      if (key === "defaultBranch" || key === "defaultTargetBranch") continue;
      if (key === "defaultGitMode") {
        if (resolved.defaultGitMode === undefined) {
          resolved.defaultGitMode = repo.defaultGitMode;
          resolved.defaultTargetBranch = repo.defaultTargetBranch;
        }
      } else if (key === "defaultPriority") {
        if (!resolved.defaultPriority || priorityWeight(repo.defaultPriority) > priorityWeight(resolved.defaultPriority)) {
          resolved.defaultPriority = repo.defaultPriority;
        }
      } else if (key === "defaultLabels") {
        resolved.defaultLabels = normalizeLabels([...(resolved.defaultLabels ?? []), ...(repo.defaultLabels ?? [])]);
      } else if (resolved[key] === undefined) {
        // Narrowing every branch individually buys nothing here — the keys and
        // value types line up by construction.
        (resolved as Record<string, unknown>)[key] = repo[key];
      }
    }
  }
  // Re-normalize so cross-repo merges can't produce an impossible combination
  // (e.g. repo A pins a provider while repo B asks for Smart Provider).
  return compact(normalizeDefaults(resolved as Record<string, unknown>));
}

/**
 * Resolve just the default priority for a task's repos. Thin wrapper over
 * {@link resolveRepoDefaults}, kept because priority is resolved on its own by
 * every headless creation path (webhooks, inbound email, Slack).
 */
export async function resolveDefaultPriorityForRepos(
  urls: (string | null | undefined)[],
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<TaskPriority | undefined> {
  return (await resolveRepoDefaults(urls, client)).defaultPriority;
}

/**
 * Fill in each repo's clone branch from its saved `defaultBranch` when the
 * caller didn't pass one. Matched by normalized scope, per repo — a task
 * spanning two repos clones each at its own default. A branch the caller
 * passed (non-blank) always wins.
 */
export async function resolveRepoBranches<T extends { url?: string | null; branch?: string | null }>(
  repos: T[],
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<(T & { branch: string | null })[]> {
  const saved = repos.length > 0 ? await getSavedRepos(client) : [];
  const byScope = new Map(saved.map((r) => [normalizeScope(r.url), r]));
  return repos.map((r) => ({
    ...r,
    branch: resolveRepoBranch(r.branch, r.url ? byScope.get(normalizeScope(r.url))?.defaultBranch : undefined),
  }));
}

/** Pure half of {@link resolveRepoBranches}: explicit branch, else the repo default, else null. */
export function resolveRepoBranch(
  branch: string | null | undefined,
  repoDefault: string | null | undefined,
): string | null {
  return (typeof branch === "string" && branch.trim()) || repoDefault?.trim() || null;
}
