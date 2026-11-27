import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toPublicMcpServer, validateMcpServerInput } from "@/lib/mcp-servers";

// Internal (UI-only) CRUD for the external MCP servers agents get connected to,
// managed from Settings → MCP Servers. Env/header values are secrets: responses mask
// them, and sending the mask back on update keeps the stored value.

export async function GET() {
  const rows = await prisma.mcpServer.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json(rows.map(toPublicMcpServer));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = validateMcpServerInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const clash = await prisma.mcpServer.findUnique({ where: { name: parsed.data.name } });
  if (clash) return NextResponse.json({ error: `An MCP server named "${parsed.data.name}" already exists` }, { status: 409 });
  const row = await prisma.mcpServer.create({ data: parsed.data });
  return NextResponse.json(toPublicMcpServer(row), { status: 201 });
}
