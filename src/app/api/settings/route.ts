import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { OTEL_SECRET_KEYS } from "@/lib/otel-config";
import { AGENT_TOOL_SECRET_KEYS } from "@/lib/agent-tools";
import { EMAIL_SECRET_KEYS } from "@/lib/email-transport";

// Mask sensitive credentials
const MASKED_KEYS = ["anthropic_api_key", "openai_api_key", "git_access_token", "git_ssh_key", ...OTEL_SECRET_KEYS, ...AGENT_TOOL_SECRET_KEYS, ...EMAIL_SECRET_KEYS];

export async function GET() {
  const settings = await prisma.setting.findMany();
  const result: Record<string, string> = {};
  for (const s of settings) {
    result[s.key] = MASKED_KEYS.includes(s.key) && s.value ? "***" : s.value;
  }
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { key, value } = body as { key: string; value: string };

  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
  // A masked secret sent back unchanged means "keep the stored value".
  if (MASKED_KEYS.includes(key) && value === "***") return NextResponse.json({ ok: true });

  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });

  // Apply OpenTelemetry changes in this process right away; the worker and
  // integrations processes pick them up on their next settings poll.
  if (key.startsWith("otel_")) {
    const { reloadTelemetry } = await import("@/lib/otel");
    await reloadTelemetry().catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
