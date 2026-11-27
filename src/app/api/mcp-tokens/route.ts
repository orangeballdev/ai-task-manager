import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateMcpToken, isMcpAccess } from "@/lib/mcp/tokens";

// Internal (UI-only, like the rest of src/app/api/*) CRUD for MCP access tokens,
// managed from Settings -> MCP. The tokens authenticate MCP clients against /api/mcp.
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

export async function GET() {
  const tokens = await prisma.mcpToken.findMany({ orderBy: { createdAt: "desc" }, select: SELECT });
  return NextResponse.json(tokens);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const access = body.access ?? "read";
  if (!isMcpAccess(access)) {
    return NextResponse.json({ error: "access must be 'read' or 'write'" }, { status: 400 });
  }

  const { token, keyHash, keyPrefix } = generateMcpToken();
  const record = await prisma.mcpToken.create({ data: { name, keyHash, keyPrefix, access }, select: SELECT });

  // The plaintext token is returned exactly once; only its hash is stored.
  return NextResponse.json({ ...record, token }, { status: 201 });
}
