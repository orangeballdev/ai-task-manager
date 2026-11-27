import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { submitClaudeLoginCode } from "@/lib/providers/claude-login-runtime";
import { saveProviderCredentials } from "@/lib/providers/save-credentials";
import { refreshProviderHealth } from "@/lib/provider-health-refresh";

/**
 * Finish "Sign in with Claude": hand the pasted code to the waiting CLI and, on success, store
 * the new login on the provider. `retry: true` on an error means the same session can take
 * another code; otherwise the user has to start again.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id, sessionId } = await params;
  const provider = await prisma.aIProvider.findUnique({ where: { id } });
  if (!provider || provider.type !== "cli") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code : "";

  const result = await submitClaudeLoginCode(sessionId, id, code);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, retry: result.retry }, { status: 400 });
  }

  const { warning } = await saveProviderCredentials(provider, result.credentialsJson);

  // Clear the "auth failing" state on the health page now rather than at the next scheduled check.
  await refreshProviderHealth(id).catch(() => {});

  return NextResponse.json(warning ? { ok: true, warning } : { ok: true });
}
