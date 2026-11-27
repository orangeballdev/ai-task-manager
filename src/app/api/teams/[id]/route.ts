import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getTeam, updateTeam, deleteTeam } from "@/lib/teams";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const team = await getTeam(id);
    if (!team) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(team);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json() as { name?: string; isDefault?: boolean };
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    const updated = await updateTeam(id, {
      name: body.name?.trim(),
      isDefault: body.isDefault,
    });
    return NextResponse.json(updated);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await deleteTeam(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
