import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseTeamProgress } from "@/lib/team-progress";

// Lightweight poll target for the task page's team tracker — just the task status,
// the recorded pipeline progress and the team's current roster (no logs).
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await prisma.task.findUnique({
    where: { id },
    select: {
      status: true,
      teamProgress: true,
      team: { select: { id: true, name: true, members: { orderBy: { position: "asc" }, select: { id: true, name: true, requiresApproval: true } } } },
    },
  });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    status: task.status,
    progress: parseTeamProgress(task.teamProgress),
    roster: task.team?.members ?? [],
  });
}
