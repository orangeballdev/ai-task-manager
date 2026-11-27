import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";
import { jsonError, readJson } from "@/lib/auth/http";
import { recordAuthEvent } from "@/lib/auth/audit";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/auth/password";

// Set or change the signed-in user's password. Signs out every *other* session.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  const user = await prisma.user.findUnique({ where: { id: auth.session.user.id } });
  if (!user) return jsonError(401, "Not signed in");

  if (user.passwordHash) {
    const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
    if (!(await verifyPassword(current, user.passwordHash))) {
      await recordAuthEvent(req.headers, {
        method: "password_change",
        success: false,
        userId: user.id,
        email: user.email,
        reason: "bad_password",
      });
      return jsonError(400, "Current password is incorrect.");
    }
  }
  const pwError = validatePasswordStrength(body.newPassword);
  if (pwError) return jsonError(400, pwError);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(body.newPassword as string), mustChangePassword: false },
  });
  const { count } = await prisma.session.deleteMany({
    where: { userId: user.id, id: { not: auth.session.sessionId } },
  });
  await recordAuthEvent(req.headers, { method: "password_change", success: true, userId: user.id, email: user.email });
  return NextResponse.json({ ok: true, signedOutSessions: count });
}
