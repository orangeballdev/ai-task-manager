import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getNotificationSettings } from "@/lib/notifications";
import { envHasAwsCredentials } from "@/lib/email-transport";

export const dynamic = "force-dynamic";

// What the Email delivery card can't see from the Setting rows alone: whether the
// server's environment has AWS credentials, and what the saved config resolves to.
// Never returns credential values.
export async function GET() {
  const { transport } = await getNotificationSettings(prisma);
  return NextResponse.json({
    envAwsCredentials: envHasAwsCredentials(process.env),
    envAwsRegion: process.env.AWS_REGION?.trim() || null,
    active: transport.kind,
    problem: transport.kind === "none" ? transport.reason : null,
    usingLegacySes: transport.kind === "ses" && !(await prisma.setting.findUnique({ where: { key: "email_transport" } })),
  });
}
