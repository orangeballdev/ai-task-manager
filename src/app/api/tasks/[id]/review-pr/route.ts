import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildReviewPrContext, REVIEW_PR_MARKER } from "@/lib/review-pr";
import { parsePRUrls } from "@/lib/git-urls";
import { REVIEW_ONLY_RUN_REFUSAL } from "@/lib/review-only";

// Re-runs a completed task on its existing branch, asking the agent to review the
// PR it opened, fix anything it finds, and end with a message written as a PR
// review comment. The worker posts that final message as a real comment on the
// PR(s) once the run completes successfully (see src/worker/index.ts).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (task.reviewOnly) return NextResponse.json({ error: REVIEW_ONLY_RUN_REFUSAL }, { status: 409 });
  if (task.status !== "completed") {
    return NextResponse.json({ error: "Only completed tasks can be reviewed" }, { status: 400 });
  }
  if (!task.branchName) {
    return NextResponse.json({ error: "Task has no branch to review" }, { status: 409 });
  }
  const hasPR = Boolean(task.prUrl) || Object.keys(parsePRUrls(task.prUrls)).length > 0;
  if (!hasPR) {
    return NextResponse.json({ error: "Task has no pull request attached" }, { status: 409 });
  }

  // Replace a previous review-request section if one exists (e.g. left behind by an
  // earlier "Review PR" click), so repeated clicks don't accumulate duplicate sections.
  const existingContext = task.context ?? "";
  const reviewInstructions = buildReviewPrContext(task.branchName);
  const sectionRegex = new RegExp(`${REVIEW_PR_MARKER}[\\s\\S]*?(?=\\n##\\s|$)`);
  const newContext = sectionRegex.test(existingContext)
    ? existingContext.replace(sectionRegex, reviewInstructions)
    : [existingContext.trim(), reviewInstructions].filter(Boolean).join("\n\n");

  // reviewIterationCount (not retryCount) is incremented so the worker treats this as a
  // resume — it reuses the existing on-disk workspace/branch instead of re-cloning and
  // branching fresh off the source branch, which would silently discard the PR's prior
  // commits (see shouldResumeTask() in src/lib/resume.ts, and the identical resume
  // pattern in the rebase-branch route). It's tracked separately from retryCount because
  // a self-review re-run — whether the agent finds nothing to change ("no changes
  // requested") or makes revisions ("changes requested") — is an expected iteration step,
  // not a failure/retry, and must not be surfaced by the UI as one.
  const updatedTask = await prisma.task.update({
    where: { id },
    data: {
      context: newContext,
      status: "pending",
      reviewStatus: null,
      reviewIterationCount: { increment: 1 },
      nextRetryAt: null,
    },
    include: { repos: true },
  });

  return NextResponse.json(updatedTask, { status: 200 });
}
