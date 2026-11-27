import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isMcpAccess } from "@/lib/mcp/tokens";

// OAuth grants (src/lib/mcp/oauth.ts) are McpToken rows too; `oauthClientId` marks them and
// `refreshExpiresAt` is when the client must sign in again unless it keeps refreshing.
const SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  access: true,
  lastUsedAt: true,
  createdAt: true,
  oauthClientId: true,
  refreshExpiresAt: true,
} as const;

/** Rename a token or change its access level (takes effect on the client's next request). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const data: { name?: string; access?: string } = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name can't be empty" }, { status: 400 });
    data.name = name;
  }
  if (body.access !== undefined) {
    if (!isMcpAccess(body.access)) return NextResponse.json({ error: "access must be 'read' or 'write'" }, { status: 400 });
    data.access = body.access;
  }
  try {
    const record = await prisma.mcpToken.update({ where: { id }, data, select: SELECT });
    return NextResponse.json(record);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.mcpToken.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
