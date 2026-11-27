import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { updateTeamMember, deleteTeamMember } from "@/lib/teams";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  try {
    const { id, memberId } = await params;
    const existing = await prisma.teamMember.findUnique({ where: { id: memberId } });
    if (!existing || existing.teamId !== id) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json() as { name?: string; instructions?: string; requiresApproval?: boolean };
    if (body.requiresApproval !== undefined && typeof body.requiresApproval !== "boolean") {
      return NextResponse.json({ error: "requiresApproval must be a boolean" }, { status: 400 });
    }
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    const updated = await updateTeamMember(memberId, {
      name: body.name?.trim(),
      instructions: body.instructions,
      requiresApproval: body.requiresApproval,
    });
    return NextResponse.json(updated);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  try {
    const { id, memberId } = await params;
    const existing = await prisma.teamMember.findUnique({ where: { id: memberId } });
    if (!existing || existing.teamId !== id) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await deleteTeamMember(memberId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
