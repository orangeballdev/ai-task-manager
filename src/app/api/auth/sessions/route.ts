import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";

// The signed-in user's active sessions. DELETE ?id=… signs one out; DELETE with no
// id signs out every session except the current one.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const sessions = await prisma.session.findMany({
    where: { userId: auth.session.user.id, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, method: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  return NextResponse.json(
    sessions.map((s: { id: string }) => ({ ...s, current: s.id === auth.session.sessionId })),
  );
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const id = req.nextUrl.searchParams.get("id");
  const where = id
    ? { id, userId: auth.session.user.id }
    : { userId: auth.session.user.id, id: { not: auth.session.sessionId } };
  const { count } = await prisma.session.deleteMany({ where });
  return NextResponse.json({ ok: true, count });
}
