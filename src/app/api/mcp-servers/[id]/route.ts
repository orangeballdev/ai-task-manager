import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toPublicMcpServer, validateMcpServerInput } from "@/lib/mcp-servers";

/** Update a server (fields left out keep their value). Takes effect from the next task run. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = await prisma.mcpServer.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const parsed = validateMcpServerInput(body, existing);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.data.name !== existing.name) {
    const clash = await prisma.mcpServer.findUnique({ where: { name: parsed.data.name } });
    if (clash) return NextResponse.json({ error: `An MCP server named "${parsed.data.name}" already exists` }, { status: 409 });
  }
  const row = await prisma.mcpServer.update({ where: { id }, data: parsed.data });
  return NextResponse.json(toPublicMcpServer(row));
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.mcpServer.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
