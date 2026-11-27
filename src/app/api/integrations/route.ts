import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Third-party credentials that should never be echoed back in full. `inboundToken`
// is deliberately excluded — it's a token *we* generate solely to build the
// copy/pasteable inbound webhook URL, so the UI needs the real value on every load.
const SENSITIVE_KEYS = ["botToken", "appToken"];

const KNOWN_INTEGRATIONS = [
  {
    id: "slack",
    name: "Slack",
  },
  {
    id: "email",
    name: "Email",
  },
];

function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  for (const key of SENSITIVE_KEYS) {
    if (masked[key]) masked[key] = "***";
  }
  return masked;
}

export async function GET() {
  const dbIntegrations = await prisma.integration.findMany();
  const dbMap = new Map(dbIntegrations.map((i: { id: string }) => [i.id, i]));

  const integrations = KNOWN_INTEGRATIONS.map(({ id, name }) => {
    const db = dbMap.get(id) as { id: string; name: string; isEnabled: boolean; config: string | null } | undefined;
    const rawConfig: Record<string, unknown> = db?.config ? JSON.parse(db.config) : {};
    return {
      id,
      name: db?.name ?? name,
      isEnabled: db?.isEnabled ?? false,
      config: maskConfig(rawConfig),
    };
  });

  return NextResponse.json(integrations);
}
