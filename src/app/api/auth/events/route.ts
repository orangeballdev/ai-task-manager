import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";

// Sign-in audit log (all accounts, newest first). ?limit=1-500 (default 100),
// ?before=<ISO date> for paging, ?failedOnly=1 to show only failures.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit")) || 100));
  const before = sp.get("before");
  const beforeDate = before ? new Date(before) : null;
  const where: Record<string, unknown> = {};
  if (beforeDate && !isNaN(beforeDate.getTime())) where.createdAt = { lt: beforeDate };
  if (sp.get("failedOnly") === "1") where.success = false;
  const events = await prisma.signInEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      email: true,
      method: true,
      success: true,
      reason: true,
      ip: true,
      userAgent: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ events, hasMore: events.length === limit });
}
