import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requestTaskChanges } from "@/lib/task-actions";

// Returns all change-request tasks linked to the given parent task, most recent first.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const changes = await prisma.task.findMany({
    where: { dependsOnTaskId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, description: true, status: true, createdAt: true },
  });
  return NextResponse.json(changes);
}

// Schedules a follow-up agent task that continues on the same branch as the
// original task — see requestTaskChanges() in src/lib/task-actions.ts (shared with
// the MCP `review_task` / `request_changes` tools).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { description } = await req.json() as { description?: string };

  const result = await requestTaskChanges(id, description ?? "");
  if (!result.ok) {
    return NextResponse.json({ error: result.code === "not_found" ? "Not found" : result.message }, { status: result.status });
  }
  return NextResponse.json(result.value, { status: 200 });
}
