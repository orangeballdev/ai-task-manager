import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth/session";
import { jsonError, readJson, signupsEnabled } from "@/lib/auth/http";
import { SIGNUPS_SETTING_KEY } from "@/lib/auth/policy";

// Whether /signup may create new accounts.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ enabled: await signupsEnabled() });
}

export async function PUT(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (typeof body.enabled !== "boolean") return jsonError(400, "enabled (boolean) is required");
  const value = body.enabled ? "true" : "false";
  await prisma.setting.upsert({
    where: { key: SIGNUPS_SETTING_KEY },
    create: { key: SIGNUPS_SETTING_KEY, value },
    update: { value },
  });
  console.log(`[auth] sign-ups ${body.enabled ? "enabled" : "disabled"} by ${auth.session.user.email}`);
  return NextResponse.json({ enabled: body.enabled });
}
