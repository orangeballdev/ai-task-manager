import { loadGitCredentials, loadGitProviderSettings } from "./git-auth";
import {
  detectProvider,
  parsePRNumber,
  getGitHubPRStatus,
  getGitLabMRStatus,
  getGitHubMergeability,
  getGitLabMergeability,
  type MergeableState,
  type CiStatus,
} from "./pr-creator";
import { parsePRUrls, type TaskPRInfo } from "./git-urls";
import { recordTaskReview } from "./task-evaluation";

const CI_RANK: Record<CiStatus, number> = { none: 0, passing: 1, pending: 2, failing: 3 };

/**
 * Poll every open PR/MR for tasks awaiting review, and flip a task from In Review to Done
 * once ALL of its PRs are merged.
 *
 * A task with multiple repos creates one PR per repo (see worker/index.ts). The task's
 * legacy prUrl/prNumber fields only ever hold the *first* PR created, so checking only
 * those (paired with task.repos[0]) would check the wrong repo/PR combination for every
 * task after the first, and would mark a task Done as soon as that single mismatched PR
 * happened to look merged — even while its other PRs were still open. This function checks
 * the full per-repo prUrls map instead, and only reports "merged" once every entry is.
 *
 * Shared by the worker's periodic poll, the manual "Sync PR status" API route, and the
 * worker's post-rebase re-check (so a task card's conflict/CI chip reflects reality as
 * soon as a "fix merge conflict" run finishes, instead of only after the next periodic
 * poll or a manual Refresh click) — so all three apply the same (correct) logic.
 */
export async function syncTaskPRStatuses(
  prisma: {
    task: {
      findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
      update: (args: unknown) => Promise<unknown>;
    };
    taskLog: { create: (args: unknown) => Promise<unknown> };
  },
  options?: { taskId?: string },
): Promise<{ synced: number; total: number; reason?: string }> {
  const gitCreds = await loadGitCredentials();
  if (!gitCreds.token) return { synced: 0, total: 0, reason: "no_token" };

  const providerSettings = await loadGitProviderSettings();

  const tasks = await prisma.task.findMany({
    where: {
      ...(options?.taskId ? { id: options.taskId } : {}),
      reviewStatus: { not: "done" },
      // Already-flagged no-changes tasks are deliberately left in In Review forever —
      // stop re-checking them so we don't keep hitting the provider API and re-writing
      // the same result on every poll.
      noChanges: false,
      OR: [{ prUrl: { not: null } }, { prUrls: { not: null } }],
    },
    include: { repos: true },
  });

  let synced = 0;
  for (const task of tasks as Array<{
    id: string;
    prUrl: string | null;
    prNumber: number | null;
    prUrls: string | null;
    mergeableState: string | null;
    ciStatus: string | null;
    repos: Array<{ alias: string; url: string }>;
  }>) {
    try {
      // Prefer the per-repo map; fall back to the legacy single-PR fields for tasks
      // created before multi-repo PR tracking existed (single-repo tasks are unaffected
      // either way since the map and the legacy fields describe the same one PR).
      const prMap: Record<string, TaskPRInfo> = parsePRUrls(task.prUrls);
      if (Object.keys(prMap).length === 0 && task.prUrl) {
        const number = task.prNumber ?? parsePRNumber(task.prUrl);
        const alias = task.repos[0]?.alias;
        if (alias && number !== null) {
          prMap[alias] = { url: task.prUrl, number };
        }
      }
      const aliases = Object.keys(prMap);
      if (aliases.length === 0) continue;

      let allMerged = true;
      let mapChanged = false;
      // True if any merged PR in this task's map came back with an empty diff. A task
      // with multiple repos still counts as "no changes" overall if even one of its PRs
      // shipped nothing — there's no code change to show for that repo either way, so it
      // shouldn't auto-advance to Done looking like a normal completed run.
      let anyNoChanges = false;
      // Aggregated across every still-open PR this round. null = no fresh signal this
      // round (e.g. every provider call returned the "still computing" indeterminate
      // state) — in that case we leave the task's existing mergeableState untouched
      // rather than clobbering a known conflicting/mergeable state with nothing.
      let worstMergeable: MergeableState | null = null;
      let worstCi: CiStatus = "none";

      for (const alias of aliases) {
        const entry = prMap[alias];
        if (entry.merged) continue; // confirmed merged in a previous poll — skip the API call

        const repo = task.repos.find((r) => r.alias === alias);
        if (!repo) { allMerged = false; continue; }

        // Each repo's check is independent — one repo's API hiccup (e.g. a transient
        // mergeability-check failure) must not prevent us from recording another repo's
        // PR as merged, nor abort evaluating the rest of this task's repos.
        try {
          const detectedProvider = detectProvider(repo.url);
          const effectiveProvider = detectedProvider !== "other" ? detectedProvider : providerSettings.provider;
          const baseUrl = providerSettings.baseUrl || "https://gitlab.com";

          const { merged, noChanges } = effectiveProvider === "github"
            ? await getGitHubPRStatus({ repoUrl: repo.url, number: entry.number, token: gitCreds.token })
            : await getGitLabMRStatus({ repoUrl: repo.url, number: entry.number, token: gitCreds.token, baseUrl });

          if (merged) {
            entry.merged = true;
            mapChanged = true;
            if (noChanges) anyNoChanges = true;
            continue;
          }
          allMerged = false;

          const { mergeableState, ciStatus } = effectiveProvider === "github"
            ? await getGitHubMergeability({ repoUrl: repo.url, number: entry.number, token: gitCreds.token })
            : await getGitLabMergeability({ repoUrl: repo.url, number: entry.number, token: gitCreds.token, baseUrl });

          if (mergeableState !== null) {
            if (mergeableState === "conflicting") worstMergeable = "conflicting";
            else if (worstMergeable !== "conflicting") worstMergeable = mergeableState;
          }
          if (CI_RANK[ciStatus] > CI_RANK[worstCi]) worstCi = ciStatus;
        } catch (err) {
          allMerged = false;
          console.error(`PR status check failed for task ${task.id} repo ${alias}:`, err instanceof Error ? err.message : err);
        }
      }

      if (allMerged) {
        if (anyNoChanges) {
          // Empty-diff PR — nothing was actually released, so don't auto-close it to
          // Done. Leave it in In Review and flag it so we stop re-checking it (see the
          // noChanges: false filter above).
          await prisma.task.update({
            where: { id: task.id },
            data: { noChanges: true, mergeableState: null, prUrls: JSON.stringify(prMap) },
          });
          await prisma.taskLog.create({
            data: { taskId: task.id, content: "PR merged with no code changes, kept in In Review.", level: "system" },
          });
          synced++;
          continue;
        }

        await prisma.task.update({
          where: { id: task.id },
          data: { reviewStatus: "done", mergeableState: null, prUrls: JSON.stringify(prMap) },
        });
        await prisma.taskLog.create({
          data: {
            taskId: task.id,
            content: aliases.length > 1 ? "All PRs merged, moved to Done." : "PR merged, moved to Done.",
            level: "system",
          },
        });
        recordTaskReview(task.id, "merged");
        synced++;
        continue;
      }

      const nextMergeableState = worstMergeable !== null ? worstMergeable : task.mergeableState;
      const stateChanged = nextMergeableState !== task.mergeableState || worstCi !== task.ciStatus;
      if (mapChanged || stateChanged) {
        await prisma.task.update({
          where: { id: task.id },
          data: {
            prUrls: JSON.stringify(prMap),
            ...(stateChanged ? { mergeableState: nextMergeableState, ciStatus: worstCi } : {}),
          },
        });
        synced++;
      }
    } catch (err) {
      console.error(`PR status sync error for task ${task.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return { synced, total: tasks.length };
}
