// Small helpers shared by the /api/auth/* route handlers.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recordAuthEvent, type AuthEventMethod } from "./audit";
import { createSession, setSessionCookie } from "./session";
import { AUTH_REQUIRED_SETTING_KEY, parseAuthRequired, parseSignupsEnabled, SIGNUPS_SETTING_KEY } from "./policy";

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function jsonError(status: number, error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

/**
 * Starts a session for a user who just proved who they are, sets the cookie on
 * the response and records the successful sign-in.
 */
export async function completeSignIn(
  req: NextRequest,
  user: { id: string; email: string },
  method: AuthEventMethod,
  body: Record<string, unknown> = { ok: true },
): Promise<NextResponse> {
  const { token, expiresAt } = await createSession(user.id, method, req.headers);
  const res = NextResponse.json(body);
  setSessionCookie(res, req, token, expiresAt);
  await recordAuthEvent(req.headers, { method, success: true, userId: user.id, email: user.email });
  return res;
}

export async function signupsEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: SIGNUPS_SETTING_KEY } });
  return parseSignupsEnabled(row?.value);
}

/** Whether the web UI requires a signed-in session (Settings → Security). Off by default. */
export async function authRequired(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: AUTH_REQUIRED_SETTING_KEY } });
  return parseAuthRequired(row?.value);
}
