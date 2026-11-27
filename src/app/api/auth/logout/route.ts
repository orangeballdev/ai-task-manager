import { NextRequest, NextResponse } from "next/server";
import { recordAuthEvent } from "@/lib/auth/audit";
import { SESSION_COOKIE } from "@/lib/auth/policy";
import { clearSessionCookie, deleteSessionByToken, findSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await findSession(token);
  await deleteSessionByToken(token);
  if (session) {
    await recordAuthEvent(req.headers, {
      method: "logout",
      success: true,
      userId: session.user.id,
      email: session.user.email,
    });
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res, req);
  return res;
}
