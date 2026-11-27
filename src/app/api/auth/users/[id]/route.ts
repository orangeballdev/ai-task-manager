import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";
import { jsonError } from "@/lib/auth/http";

// Delete another account (and with it, its sessions and passkeys). You can't
// delete yourself, so there's always at least one account left.
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (id === auth.session.user.id) return jsonError(400, "You can't delete your own account.");
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return jsonError(404, "Account not found");
  await prisma.user.delete({ where: { id } });
  console.log(`[auth] account ${user.email} deleted by ${auth.session.user.email}`);
  return NextResponse.json({ ok: true });
}
