import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { addTeamMember } from "@/lib/teams";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const team = await prisma.team.findUnique({ where: { id } });
    if (!team) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json() as { name?: string; instructions?: string; requiresApproval?: boolean };
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const member = await addTeamMember(id, {
      name,
      instructions: body.instructions?.trim() ?? "",
      requiresApproval: body.requiresApproval === true,
    });
    return NextResponse.json(member, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
