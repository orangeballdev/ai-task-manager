import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const ALLOWED_STATUSES = ["all", "failed", "killed", "completed", "no_changes", "timedout"] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

export async function DELETE(req: NextRequest) {
  const { status } = await req.json() as { status: AllowedStatus };

  if (!ALLOWED_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const where =
    status === "all"
      ? { isRecurringTemplate: false }
      : { isRecurringTemplate: false, status };

  const { count } = await prisma.task.deleteMany({ where });
  return NextResponse.json({ ok: true, count });
}
