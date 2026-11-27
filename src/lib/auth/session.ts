// Browser sessions. The cookie carries a random 32-byte token; the DB stores only
// its SHA-256 hash (Session.tokenHash), so a leaked database can't be replayed as
// a login. Used by the proxy (src/proxy.ts), route handlers and server components.
import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE, SESSION_TTL_MS, isSecureRequest } from "./policy";
import { clientIp, clientUserAgent } from "./request-info";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  mustChangePassword: boolean;
}

export interface CurrentSession {
  sessionId: string;
  user: SessionUser;
}

/** lastSeenAt is only written when it's older than this, to keep polling cheap. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  method: string,
  headers: { get(name: string): string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      method,
      ip: clientIp(headers),
      userAgent: clientUserAgent(headers),
      expiresAt,
    },
  });
  // Opportunistic cleanup of long-dead sessions/challenges.
  prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  prisma.authChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  return { token, expiresAt };
}

export async function findSession(token: string | undefined | null): Promise<CurrentSession | null> {
  if (!token || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: { select: { id: true, email: true, name: true, mustChangePassword: true } } },
  });
  if (!session) return null;
  const now = Date.now();
  if (new Date(session.expiresAt).getTime() <= now) {
    prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (now - new Date(session.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
    prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return { sessionId: session.id, user: session.user };
}

export async function deleteSessionByToken(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

function cookieSecure(req: NextRequest): boolean {
  return isSecureRequest(req.headers.get("x-forwarded-proto"), req.nextUrl.protocol);
}

export function setSessionCookie(res: NextResponse, req: NextRequest, token: string, expiresAt: Date): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: NextResponse, req: NextRequest): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    path: "/",
    maxAge: 0,
  });
}

/** The signed-in user for the current server component / route, or null. */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const store = await cookies();
  return findSession(store.get(SESSION_COOKIE)?.value);
}

/** For route handlers: the session, or a 401 response to return as-is. */
export async function requireSession(
  req: NextRequest,
): Promise<{ ok: true; session: CurrentSession } | { ok: false; response: NextResponse }> {
  const session = await findSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }
  return { ok: true, session };
}
