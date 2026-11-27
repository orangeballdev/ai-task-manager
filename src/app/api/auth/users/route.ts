import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";

// Every account on this instance (they all share the same data).
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      passwordLoginDisabled: true,
      createdAt: true,
      _count: { select: { passkeys: true, sessions: true } },
    },
  });
  return NextResponse.json(
    users.map((u: { id: string; _count: { passkeys: number; sessions: number } }) => ({
      ...u,
      passkeyCount: u._count.passkeys,
      sessionCount: u._count.sessions,
      current: u.id === auth.session.user.id,
    })),
  );
}
