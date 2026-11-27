import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest, apiError } from "@/lib/api-auth";
import { serializeTask } from "@/lib/api-v1";
import { createTaskFromInput, type CreateTaskInput } from "@/lib/task-actions";
import { reviewSearchClauses } from "@/lib/review-only";

// Public API — create/list tasks. See src/app/docs/api for the documented, testable
// version of this contract; keep the two in sync when this route's shape changes.
//
// This is intentionally a smaller surface than the internal POST /api/tasks used by the
// UI (no teams, recurring templates, dependencies, etc.) — those can be added here later
// if/when they're worth documenting publicly, but the public contract should only ever
// grow, not reshape, once someone is depending on it.
export async function GET(req: NextRequest) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status")?.trim();
  const limitParam = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 100) : 20;
  // q: free text over title/description/context, plus commit SHAs and PR URLs
  // (review metadata and agent commits/PRs). reviewOnly=true|false filters on the kind.
  const q = searchParams.get("q")?.trim();
  const reviewOnlyParam = searchParams.get("reviewOnly");

  const tasks = await prisma.task.findMany({
    where: {
      isRecurringTemplate: false,
      ...(status ? { status } : {}),
      ...(reviewOnlyParam === "true" ? { reviewOnly: true } : reviewOnlyParam === "false" ? { reviewOnly: false } : {}),
      ...(q ? {
        OR: [
          { title: { contains: q } },
          { description: { contains: q } },
          { context: { contains: q } },
          ...reviewSearchClauses(q),
        ],
      } : {}),
    },
    include: { repos: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ data: tasks.map(serializeTask) });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiError(400, "Request body must be valid JSON.", "invalid_request");

  // Only the documented public fields are forwarded — dependsOnTaskId/teamId/
  // scheduledFor are accepted by createTaskFromInput() for MCP but aren't part of
  // the public REST contract.
  const {
    title, description, context, repos, outputType, priority, effort, model, labels,
    pushToMain, createPR, targetBranch, tokenBudget, costBudget, autoStart, toolAccess, allowSubtasks,
    reviewOnly, reviewMetadata, notes,
  } = body as CreateTaskInput;

  const result = await createTaskFromInput({
    title, description, context, repos, outputType, priority, effort, model, labels,
    pushToMain, createPR, targetBranch, tokenBudget, costBudget, autoStart, toolAccess, allowSubtasks,
    reviewOnly: reviewOnly === true, reviewMetadata, notes: typeof notes === "string" ? notes : undefined,
  });
  if (!result.ok) return apiError(result.status, result.message, result.code);

  return NextResponse.json({ data: serializeTask(result.value) }, { status: 201 });
}
