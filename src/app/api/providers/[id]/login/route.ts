import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cancelClaudeLogin, startClaudeLogin } from "@/lib/providers/claude-login-runtime";

/** Start "Sign in with Claude" for a `cli` provider: returns the sign-in URL to open. */
export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await prisma.aIProvider.findUnique({ where: { id }, select: { type: true } });
  if (!provider || provider.type !== "cli") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const { sessionId, url } = await startClaudeLogin(id);
    return NextResponse.json({ sessionId, url });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/** Abandon a sign-in in progress: `DELETE /api/providers/[id]/login?session=…`. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = req.nextUrl.searchParams.get("session");
  if (sessionId) cancelClaudeLogin(sessionId, id);
  return NextResponse.json({ ok: true });
}
