import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";
import { jsonError, readJson } from "@/lib/auth/http";
import { passwordLoginAllowed } from "@/lib/auth/policy";

// The signed-in user's account: profile, passkeys and sign-in method state.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const user = await prisma.user.findUnique({
    where: { id: auth.session.user.id },
    include: {
      passkeys: {
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, deviceType: true, backedUp: true, createdAt: true, lastUsedAt: true },
      },
    },
  });
  if (!user) return jsonError(401, "Not signed in");
  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    hasPassword: !!user.passwordHash,
    mustChangePassword: user.mustChangePassword,
    passwordLoginDisabled: user.passwordLoginDisabled,
    passwordLoginAllowed: passwordLoginAllowed({
      passwordHash: user.passwordHash,
      passwordLoginDisabled: user.passwordLoginDisabled,
      passkeyCount: user.passkeys.length,
    }),
    passkeys: user.passkeys,
    createdAt: user.createdAt,
  });
}

/** Update profile fields (currently just the display name). */
export async function PATCH(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (typeof body.name !== "string") return jsonError(400, "name is required");
  const name = body.name.trim().slice(0, 100) || null;
  await prisma.user.update({ where: { id: auth.session.user.id }, data: { name } });
  return NextResponse.json({ ok: true, name });
}
