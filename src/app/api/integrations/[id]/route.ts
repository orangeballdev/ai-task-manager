import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { INTEGRATIONS_OFF_MESSAGE, integrationsServiceEnabled } from "@/lib/deployment";

// Third-party credentials that should never be echoed back in full. `inboundToken`
// is deliberately excluded — it's a token *we* generate solely to build the
// copy/pasteable inbound webhook URL, so the UI needs the real value on every load.
const SENSITIVE_KEYS = ["botToken", "appToken"];
const MASK_VALUE = "***";

function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  for (const key of SENSITIVE_KEYS) {
    if (masked[key]) masked[key] = "***";
  }
  return masked;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json() as { isEnabled?: boolean; config?: Record<string, unknown> };

  // The Slack bot runs in the integrations process; switching it on where that
  // process doesn't run would only look like it worked.
  if (id === "slack" && body.isEnabled === true && !integrationsServiceEnabled()) {
    return NextResponse.json({ error: INTEGRATIONS_OFF_MESSAGE }, { status: 409 });
  }

  const existing = await prisma.integration.findUnique({ where: { id } });
  const existingConfig: Record<string, unknown> = existing?.config
    ? JSON.parse(existing.config as string)
    : {};

  // Merge config, keeping existing values for masked/empty fields
  const mergedConfig = { ...existingConfig };
  if (body.config) {
    for (const [key, value] of Object.entries(body.config)) {
      if (value === MASK_VALUE) continue; // Don't overwrite with mask placeholder
      if (value === "" || value === null || value === undefined) {
        delete mergedConfig[key];
      } else {
        mergedConfig[key] = value;
      }
    }
  }

  const displayName = id.charAt(0).toUpperCase() + id.slice(1);

  const integration = await prisma.integration.upsert({
    where: { id },
    create: {
      id,
      name: displayName,
      isEnabled: body.isEnabled ?? false,
      config: JSON.stringify(mergedConfig),
      updatedAt: new Date(),
    },
    update: {
      ...(typeof body.isEnabled === "boolean" ? { isEnabled: body.isEnabled } : {}),
      config: JSON.stringify(mergedConfig),
      updatedAt: new Date(),
    },
  });

  const returnConfig: Record<string, unknown> = integration.config
    ? JSON.parse(integration.config as string)
    : {};

  return NextResponse.json({
    id: integration.id,
    name: integration.name,
    isEnabled: integration.isEnabled,
    config: maskConfig(returnConfig),
  });
}
