import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { detectDefaultBranch } from "@/lib/git";
import { getRepoDest } from "@/lib/workspace";
import fs from "fs";
import { REVIEW_ONLY_RUN_REFUSAL } from "@/lib/review-only";

const REBASE_SECTION_HEADER = "## Make Branch Mergeable";

/**
 * POST /api/tasks/[id]/rebase-branch
 *
 * Resumes the task in place (same task row, same on-disk workspace) with an
 * instruction to make the branch mergeable again: rebase onto the latest
 * upstream base branch, resolve any conflicts, and — if CI is currently
 * failing — investigate and fix it too. This mirrors how rate-limit retries
 * resume a task: retryCount is incremented (not reset to 0) so the worker
 * reuses the existing clone instead of re-cloning, and the agent can see its
 * own prior commits via `git log`.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const task = await prisma.task.findUnique({ where: { id }, include: { repos: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (task.reviewOnly) return NextResponse.json({ error: REVIEW_ONLY_RUN_REFUSAL }, { status: 409 });

  if (!task.branchName) {
    return NextResponse.json({ error: "Task has no branch to rebase" }, { status: 409 });
  }
  if (!task.repos || task.repos.length === 0) {
    return NextResponse.json({ error: "Task has no repos configured" }, { status: 409 });
  }
  if (task.status === "pending" || task.status === "running") {
    return NextResponse.json({ error: "Task is already running" }, { status: 409 });
  }

  // The configured PR target branch (e.g. "develop") takes priority over the repo's own
  // git default branch (e.g. "main") — PRs are opened against the former, so conflicts
  // must be resolved against the same branch, not whatever HEAD happens to point at.
  const baseSetting = await prisma.setting.findUnique({ where: { key: "git_default_base_branch" } });
  const configuredBase = baseSetting?.value?.trim() || null;

  const repoLines = await Promise.all(
    (task.repos as Array<{ alias: string }>).map(async (repo) => {
      const dest = getRepoDest(id, repo.alias);
      const base = configuredBase
        ?? (fs.existsSync(`${dest}/.git`) ? await detectDefaultBranch(dest) : "main");
      return `- ${repo.alias}: rebase onto \`origin/${base}\``;
    })
  );

  const ciFailing = task.ciStatus === "failing";

  const rebaseInstruction = `${REBASE_SECTION_HEADER}
This task's branch (\`${task.branchName}\`) currently can't be merged${ciFailing ? " — it has merge conflicts and/or failing CI checks" : " because the upstream base branch has moved ahead"}. Before doing anything else this run:

1. For each repo below, fetch the base branch and rebase this branch onto it (\`git fetch origin <base> && git rebase origin/<base>\`).
${repoLines.join("\n")}
2. If the rebase reports conflicts, resolve them by hand: open each conflicted file, merge the two sides so that BOTH this branch's functionality and the upstream changes are preserved — do not blindly discard either side with \`--ours\`/\`--theirs\` unless one side is fully superseded by the other. Stage resolved files with \`git add\` and run \`git rebase --continue\`, repeating until the rebase completes.
3. Do not run \`git rebase --abort\`. Do not force-push — the system pushes automatically once this run finishes.${ciFailing ? `
4. CI is currently failing on this branch. After the rebase completes, investigate the failure (check the repo's CI config and recent error output, run the relevant tests/build/lint locally) and fix it.` : ""}
${ciFailing ? "5" : "4"}. Once the rebase is complete, all conflicts are resolved${ciFailing ? ", and CI should now pass" : ""}, this run is done — do not start new feature work.`;

  // Replace a previous rebase-request section if one exists, so repeated clicks don't accumulate.
  const existingContext = task.context ?? "";
  const sectionRegex = new RegExp(`${REBASE_SECTION_HEADER}[\\s\\S]*?(?=\\n##\\s|$)`);
  const newContext = sectionRegex.test(existingContext)
    ? existingContext.replace(sectionRegex, rebaseInstruction)
    : [existingContext.trim(), rebaseInstruction].filter(Boolean).join("\n\n");

  const updated = await prisma.task.update({
    where: { id },
    data: {
      context: newContext,
      status: "pending",
      reviewStatus: null,
      retryCount: { increment: 1 },
      nextRetryAt: null,
    },
    include: { repos: true },
  });

  return NextResponse.json(updated);
}
