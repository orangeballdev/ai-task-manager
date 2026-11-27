import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { findSession } from "@/lib/auth/session";
import { authRequired, jsonError, readJson } from "@/lib/auth/http";
import { AUTH_REQUIRED_SETTING_KEY, checkAuthRequiredToggle, SESSION_COOKIE } from "@/lib/auth/policy";

// Whether the web UI requires signing in. While it's off the proxy lets every request
// through, so these handlers can be reached without a session; while it's on, the
// proxy has already demanded one.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await findSession(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ required: await authRequired(), signedIn: !!session });
}

export async function PUT(req: NextRequest) {
  const session = await findSession(req.cookies.get(SESSION_COOKIE)?.value);
  const body = await readJson(req);
  if (typeof body.required !== "boolean") return jsonError(400, "required (boolean) is required");
  const refusal = checkAuthRequiredToggle(body.required, !!session);
  if (refusal) return jsonError(session ? 400 : 401, refusal);
  const value = body.required ? "true" : "false";
  await prisma.setting.upsert({
    where: { key: AUTH_REQUIRED_SETTING_KEY },
    create: { key: AUTH_REQUIRED_SETTING_KEY, value },
    update: { value },
  });
  console.log(`[auth] required sign-in ${body.required ? "enabled" : "disabled"} by ${session!.user.email}`);
  return NextResponse.json({ required: body.required });
}
