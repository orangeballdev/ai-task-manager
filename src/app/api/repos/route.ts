import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  DuplicateRepoUrlError,
  deriveAlias,
  excludeSavedRepos,
  getHiddenRecentRepoUrls,
  getSavedRepos,
  hideRecentRepo,
  removeSavedRepo,
  upsertSavedRepo,
  type RepoSettingsInput,
  type SavedRepo,
} from "@/lib/repos";

type GitMode = "branch" | "target" | "main" | "pr";

interface RepoDefaults {
  lastBranch?: string;
  lastGitMode?: GitMode;
  lastTargetBranch?: string;
}

// Derive the "after task completes" mode from the task fields that were saved
// alongside a given repo, so the new-task form can prepopulate it the next
// time the same repo is used. Mirrors the gitMode derivation logic used in
// tasks/new & edit pages (targetBranch > pushToMain > createPR > plain branch).
function deriveGitMode(task: { pushToMain: boolean; createPR: boolean; targetBranch: string | null } | null | undefined): GitMode | undefined {
  if (!task) return undefined;
  if (task.targetBranch) return "target";
  if (task.pushToMain) return "main";
  if (task.createPR) return "pr";
  return "branch";
}

export async function GET() {
  const [recentRepoRows, savedRepos, hiddenRecentUrls] = await Promise.all([
    prisma.taskRepo.findMany({
      select: {
        url: true,
        alias: true,
        branch: true,
        task: { select: { pushToMain: true, createPR: true, targetBranch: true } },
      },
      // One row per distinct url, keeping the most recently created (id desc),
      // so the attached branch/gitMode reflect the last time this repo was used.
      distinct: ["url"],
      orderBy: { id: "desc" },
    }),
    getSavedRepos(),
    getHiddenRecentRepoUrls(),
  ]);
  const hiddenSet = new Set(hiddenRecentUrls);

  interface RecentRepo { url: string; alias: string; lastBranch?: string; lastGitMode?: GitMode; lastTargetBranch?: string }

  const recentRepos: RecentRepo[] = recentRepoRows.map((r: { url: string; alias: string; branch: string | null; task: { pushToMain: boolean; createPR: boolean; targetBranch: string | null } | null }) => ({
    url: r.url,
    alias: r.alias,
    lastBranch: r.branch ?? undefined,
    lastGitMode: deriveGitMode(r.task),
    lastTargetBranch: r.task?.targetBranch ?? undefined,
  }));

  const recentByUrl = new Map(recentRepos.map((r) => [r.url, r]));

  function defaultsFor(url: string): RepoDefaults {
    const match = recentByUrl.get(url);
    if (!match) return {};
    return {
      lastBranch: match.lastBranch,
      lastGitMode: match.lastGitMode,
      lastTargetBranch: match.lastTargetBranch,
    };
  }

  // Return saved repos first (with saved: true), then recent ones not already in saved list
  // (matched by normalized scope, so e.g. an SSH vs HTTPS form of the same repo doesn't show
  // up twice) and not explicitly dismissed by the user. Each entry carries the last-used
  // branch / "after task completes" setting (when known) so the new-task form can prepopulate
  // those fields when a repo is picked from the dropdown.
  const result = [
    ...savedRepos.map((r: SavedRepo) => ({ ...r, saved: true, ...defaultsFor(r.url) })),
    ...excludeSavedRepos(recentRepos, savedRepos)
      .filter((r: RecentRepo) => !hiddenSet.has(r.url))
      .map((r: RecentRepo) => ({ ...r, saved: false })),
  ];

  return NextResponse.json(result);
}

// Pull just the per-repo settings (advanced-option defaults + the concurrency
// cap) out of a request body. Keys the caller didn't send stay `undefined`,
// which upsertSavedRepo reads as "leave this one alone" (vs. `null`, which
// clears it).
function readDefaults(body: Record<string, unknown>): RepoSettingsInput {
  const keys = [
    "maxConcurrentTasks",
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
  ] as const;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out as RepoSettingsInput;
}

export async function POST(req: NextRequest) {
  const body = await req.json() as Record<string, unknown> & { url?: string; alias?: string };
  const { url, alias } = body;
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  await upsertSavedRepo({ url, alias: alias || deriveAlias(url), ...readDefaults(body) });
  return NextResponse.json({ ok: true });
}

// Update alias, clone URL, the concurrent-task cap, and/or any of the per-repo
// task defaults (context, priority, effort, budgets, provider, model, labels,
// validation task) for an already-saved repo (matched by exact url; pass
// `newUrl` to amend the clone URL itself). Creates the preset if it does not
// exist yet.
export async function PATCH(req: NextRequest) {
  const body = await req.json() as Record<string, unknown> & {
    url?: string;
    newUrl?: string;
    alias?: string;
  };
  const { url, newUrl, alias } = body;
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  try {
    await upsertSavedRepo({ url, newUrl, alias, ...readDefaults(body) });
  } catch (err) {
    if (err instanceof DuplicateRepoUrlError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}

// Removes a repository. `scope: "recent"` dismisses a not-yet-saved entry
// from the "Recently used" list (cosmetic only — task history is untouched).
// Any other scope (the default) removes a saved preset, deleting its default
// context.
export async function DELETE(req: NextRequest) {
  const body = await req.json() as { url?: string; scope?: "recent" | "saved" };
  const { url, scope } = body;
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  if (scope === "recent") {
    await hideRecentRepo(url);
  } else {
    await removeSavedRepo(url);
  }
  return NextResponse.json({ ok: true });
}
