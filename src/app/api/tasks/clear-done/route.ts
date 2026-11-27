import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cleanWorkspacesInBackground } from "@/lib/workspace";

// Bulk-delete a set of tasks (used by the Kanban "Clear all" button on the
// Done column) in a single request instead of one DELETE per task. This
// collapses what used to be 3N+ sequential DB round trips across N separate
// HTTP requests into a handful of batched queries, then cleans up the
// per-task workspace directories in the background.
export async function POST(req: NextRequest) {
  let ids: unknown;
  try {
    ({ ids } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "`ids` must be an array of strings" }, { status: 400 });
  }
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, count: 0 });
  }

  try {
    // Null out self-referential FKs in bulk before deleting (same reasoning
    // as the single-task DELETE route: avoids constraint issues with SQLite
    // under the better-sqlite3 adapter).
    await prisma.task.updateMany({ where: { recurringTemplateId: { in: ids } }, data: { recurringTemplateId: null } });
    await prisma.task.updateMany({ where: { dependsOnTaskId: { in: ids } }, data: { dependsOnTaskId: null } });
    const { count } = await prisma.task.deleteMany({ where: { id: { in: ids } } });
    // Workspace dirs are removed after responding — see cleanWorkspacesInBackground.
    cleanWorkspacesInBackground(ids);
    return NextResponse.json({ ok: true, count });
  } catch (error) {
    console.error("Failed to bulk delete tasks:", error);
    return NextResponse.json({ error: "Failed to delete tasks" }, { status: 500 });
  }
}
