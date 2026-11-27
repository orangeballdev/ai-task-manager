import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";
import { jsonError, readJson } from "@/lib/auth/http";
import { checkPasswordLoginToggle } from "@/lib/auth/policy";

// Turn email + password sign-in off (passkey only) or back on for the signed-in user.
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (typeof body.disabled !== "boolean") return jsonError(400, "disabled (boolean) is required");

  const user = await prisma.user.findUnique({
    where: { id: auth.session.user.id },
    include: { _count: { select: { passkeys: true } } },
  });
  if (!user) return jsonError(401, "Not signed in");
  const err = checkPasswordLoginToggle(
    { passwordHash: user.passwordHash, passwordLoginDisabled: user.passwordLoginDisabled, passkeyCount: user._count.passkeys },
    body.disabled,
  );
  if (err) return jsonError(400, err);

  await prisma.user.update({ where: { id: user.id }, data: { passwordLoginDisabled: body.disabled } });
  return NextResponse.json({ ok: true, passwordLoginDisabled: body.disabled });
}
