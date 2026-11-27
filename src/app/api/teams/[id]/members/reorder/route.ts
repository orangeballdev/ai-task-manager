import { NextRequest, NextResponse } from "next/server";
import { reorderTeamMembers } from "@/lib/teams";

// Persists a new drag-and-drop order for a team's members immediately on drop —
// mirrors POST /api/tasks/reorder.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ids }: { ids: string[] } = await req.json();
  await reorderTeamMembers(id, ids);
  return NextResponse.json({ ok: true });
}
