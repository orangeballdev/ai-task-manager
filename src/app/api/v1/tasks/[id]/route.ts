import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest, apiError } from "@/lib/api-auth";
import { serializeTask } from "@/lib/api-v1";
import { updateTaskFromInput, type UpdateTaskInput } from "@/lib/task-actions";

// Public API — fetch a task's current status/results. Pass `?logs=true` to include the
// full run log (otherwise omitted to keep the default response small).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const includeLogs = searchParams.get("logs") === "true";

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      repos: true,
      files: { where: { parentId: null }, select: { id: true, name: true, isFolder: true } },
    },
  });

  if (!task) return apiError(404, `No task found with id '${id}'.`, "not_found");

  const logs = includeLogs
    ? await prisma.taskLog.findMany({
        where: { taskId: id },
        orderBy: { createdAt: "asc" },
        select: { level: true, content: true, member: true, createdAt: true },
      })
    : null;

  const data = {
    ...serializeTask(task),
    files: task.files.map((f: { id: string; name: string; isFolder: boolean }) => ({ id: f.id, name: f.name, isFolder: f.isFolder })),
    ...(logs && {
      logs: logs.map((l: { level: string; content: string; member: string | null; createdAt: Date }) => ({
        level: l.level,
        ...(l.member && { member: l.member }),
        content: l.content,
        createdAt: l.createdAt.toISOString(),
      })),
    }),
  };

  return NextResponse.json({ data });
}

// Public API — edit a task's ticket fields (title, description, context, priority,
// labels, notes) and, on a review-only task, its review metadata. Only the fields
// sent change; `reviewMetadata` keys set to null / "" / [] are cleared.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return apiError(400, "Request body must be valid JSON.", "invalid_request");

  const { id } = await params;
  const { title, description, context, priority, labels, notes, reviewMetadata } = body as UpdateTaskInput;
  const result = await updateTaskFromInput(id, { title, description, context, priority, labels, notes, reviewMetadata });
  if (!result.ok) return apiError(result.status, result.message, result.code);

  return NextResponse.json({ data: serializeTask(result.value) });
}
