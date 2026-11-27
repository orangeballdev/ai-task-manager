import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getNotificationSettings, sendEmail } from "@/lib/notifications";

export async function POST(req: NextRequest) {
  const { email } = await req.json() as { email: string };
  if (!email) {
    return NextResponse.json({ ok: false, error: "email is required" }, { status: 400 });
  }

  try {
    const { transport } = await getNotificationSettings(prisma);
    await sendEmail(
      email,
      "Test notification from AI Task Manager",
      "This is a test notification from your AI Task Manager. Email notifications are working correctly!",
      undefined,
      transport,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send email";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
