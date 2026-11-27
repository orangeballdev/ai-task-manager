/**
 * Per-repository concurrency limits.
 *
 * The global `concurrent_tasks` setting caps how many tasks the worker runs at
 * once across the whole system. That's not always enough: some repos care about
 * state (a shared dev database, migrations, a single deploy target) or simply
 * produce conflicting branches when two agents touch them at the same time.
 *
 * A saved repo can therefore carry a `maxConcurrentTasks` cap (see
 * {@link SavedRepo} in src/lib/repos.ts). The worker consults it every poll
 * cycle: a task is only started if **every** repo it touches still has a free
 * slot. Tasks are never re-ordered or blocked as a group — a task held back by
 * a busy repo is simply skipped, and the next eligible task (for a different
 * repo) takes the slot. That keeps one serialized repo from stalling the queue.
 *
 * Repo identity is matched on the normalized scope (see normalizeScope in
 * src/lib/git-urls.ts) so `git@github.com:acme/foo.git` and
 * `https://github.com/acme/foo` count against the same limit.
 *
 * Kept free of DB/Prisma imports so the worker's scheduling decisions stay
 * unit-testable in isolation.
 */

import { normalizeScope } from "./git-urls";

/** Minimal shape of a task for limit purposes: its id and the repos it touches. */
export interface ConcurrencyTask {
  id: string;
  repos: { url: string }[];
}

export interface RepoConcurrencyBlock<T> {
  task: T;
  /** Normalized scope of the repo that's at its limit. */
  scope: string;
  /** The repo's configured limit. */
  limit: number;
  /** How many tasks are currently occupying that repo. */
  running: number;
}

export interface RepoConcurrencySelection<T> {
  /** Tasks that can start now, in the order they were offered. */
  selected: T[];
  /** Tasks skipped because one of their repos is already at its limit. */
  blocked: RepoConcurrencyBlock<T>[];
}

/** Distinct normalized repo scopes a task touches (a task can span repos). */
export function taskRepoScopes(task: ConcurrencyTask): string[] {
  const scopes = new Set<string>();
  for (const repo of task.repos ?? []) {
    if (!repo?.url) continue;
    scopes.add(normalizeScope(repo.url));
  }
  return Array.from(scopes);
}

/**
 * Build a `normalized scope -> limit` map from saved repo presets. Repos with
 * no cap are omitted entirely, so a missing key means "unlimited".
 *
 * If two presets normalize to the same scope (e.g. the SSH and HTTPS URLs of
 * one repo were both saved), the strictest limit wins — the user asked for at
 * most N somewhere, and honouring the looser one would break that promise.
 */
export function buildRepoConcurrencyLimits(
  repos: { url: string; maxConcurrentTasks?: number }[],
): Map<string, number> {
  const limits = new Map<string, number>();
  for (const repo of repos) {
    const limit = repo?.maxConcurrentTasks;
    if (!repo?.url || typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) continue;
    const scope = normalizeScope(repo.url);
    const existing = limits.get(scope);
    limits.set(scope, existing === undefined ? Math.floor(limit) : Math.min(existing, Math.floor(limit)));
  }
  return limits;
}

/**
 * Count how many of the given (in-flight) tasks occupy each repo scope. A task
 * spanning several repos counts once against each of them.
 */
export function countTasksPerRepo(tasks: ConcurrencyTask[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    for (const scope of taskRepoScopes(task)) {
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Pick which of `candidates` (already ordered by priority/position) may start,
 * respecting both the number of free global slots and each repo's own limit.
 *
 * Candidates beyond `availableSlots` are neither selected nor reported as
 * blocked — they're just next in line, which is normal queueing rather than
 * something the user configured.
 */
export function selectTasksWithinRepoLimits<T extends ConcurrencyTask>(
  candidates: T[],
  options: {
    limits: Map<string, number>;
    /** Scope -> number of tasks already running against it. */
    running: Map<string, number>;
    availableSlots: number;
  },
): RepoConcurrencySelection<T> {
  const { limits, running, availableSlots } = options;
  const selected: T[] = [];
  const blocked: RepoConcurrencyBlock<T>[] = [];
  if (availableSlots <= 0) return { selected, blocked };

  // Local tally so tasks picked earlier in this same pass count against the
  // limit for the ones considered after them.
  const counts = new Map(running);

  for (const task of candidates) {
    if (selected.length >= availableSlots) break;
    const scopes = taskRepoScopes(task);

    let blocker: { scope: string; limit: number; running: number } | undefined;
    for (const scope of scopes) {
      const limit = limits.get(scope);
      if (limit === undefined) continue;
      const inUse = counts.get(scope) ?? 0;
      if (inUse >= limit) {
        blocker = { scope, limit, running: inUse };
        break;
      }
    }

    if (blocker) {
      blocked.push({ task, ...blocker });
      continue;
    }

    selected.push(task);
    for (const scope of scopes) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }

  return { selected, blocked };
}

/** Human-readable reason a task is waiting, for logs and the task timeline. */
export function repoLimitWaitMessage(block: RepoConcurrencyBlock<unknown>): string {
  return `Waiting for a free slot on ${block.scope}: it allows ${block.limit} concurrent task${
    block.limit === 1 ? "" : "s"
  } and ${block.running} ${block.running === 1 ? "is" : "are"} already running.`;
}
