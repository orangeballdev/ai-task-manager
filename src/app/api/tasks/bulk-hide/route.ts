import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST /api/tasks/bulk-hide — hide (or unhide) several tasks on the board at once.
// Body: { ids: string[], hidden: boolean }. `hiddenOnBoard` is display-only: it never
// changes whether or when the worker runs a task.
export async function POST(req: NextRequest) {
  let body: { ids?: unknown; hidden?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { ids, hidden } = body;

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "ids must be a non-empty array of task ids" }, { status: 400 });
  }
  if (typeof hidden !== "boolean") {
    return NextResponse.json({ error: "hidden must be a boolean" }, { status: 400 });
  }

  const { count } = await prisma.task.updateMany({
    where: { id: { in: ids as string[] } },
    data: { hiddenOnBoard: hidden },
  });

  return NextResponse.json({ ok: true, count });
}
