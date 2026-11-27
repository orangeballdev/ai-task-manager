import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";
import { jsonError, readJson } from "@/lib/auth/http";
import { checkPasskeyRemoval, reenablePasswordAfterRemoval } from "@/lib/auth/policy";

// Rename (PATCH { name }) or remove (DELETE) one of the signed-in user's passkeys.
export const dynamic = "force-dynamic";

async function ownPasskey(userId: string, id: string) {
  return prisma.passkey.findFirst({ where: { id, userId } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(req);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (!name) return jsonError(400, "name is required");
  if (!(await ownPasskey(auth.session.user.id, id))) return jsonError(404, "Passkey not found");
  await prisma.passkey.update({ where: { id }, data: { name } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!(await ownPasskey(auth.session.user.id, id))) return jsonError(404, "Passkey not found");
  const user = await prisma.user.findUnique({
    where: { id: auth.session.user.id },
    include: { _count: { select: { passkeys: true } } },
  });
  if (!user) return jsonError(401, "Not signed in");
  const state = {
    passwordHash: user.passwordHash,
    passwordLoginDisabled: user.passwordLoginDisabled,
    passkeyCount: user._count.passkeys,
  };
  const err = checkPasskeyRemoval(state);
  if (err) return jsonError(400, err);
  const reenable = reenablePasswordAfterRemoval(state);
  await prisma.$transaction([
    prisma.passkey.delete({ where: { id } }),
    ...(reenable ? [prisma.user.update({ where: { id: user.id }, data: { passwordLoginDisabled: false } })] : []),
  ]);
  return NextResponse.json({ ok: true, passwordLoginReenabled: reenable });
}
