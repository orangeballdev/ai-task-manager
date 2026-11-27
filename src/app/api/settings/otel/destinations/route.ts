import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  LEGACY_OTEL_DESTINATION_KEYS,
  OTEL_SETTING_KEYS,
  maskDestinations,
  mergeDestinationSecrets,
  parseStoredDestinations,
  readStoredDestinations,
} from "@/lib/otel-config";
import { reloadTelemetry } from "@/lib/otel";

async function loadSaved() {
  const keys = [OTEL_SETTING_KEYS.destinations, ...Object.values(LEGACY_OTEL_DESTINATION_KEYS)];
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  return readStoredDestinations(Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value])));
}

/** The OpenTelemetry destinations, with headers masked. */
export async function GET() {
  return NextResponse.json({ destinations: maskDestinations(await loadSaved()) });
}

/**
 * Replaces the whole destinations list. Headers still set to the mask keep
 * their saved value. The first save also retires the single-collector
 * settings the list was seeded from, so their headers don't linger.
 */
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { destinations?: unknown } | null;
  if (!body || !Array.isArray(body.destinations)) {
    return NextResponse.json({ error: "destinations must be an array" }, { status: 400 });
  }
  const destinations = mergeDestinationSecrets(parseStoredDestinations(body.destinations), await loadSaved());
  const value = JSON.stringify(destinations);

  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: OTEL_SETTING_KEYS.destinations },
      create: { key: OTEL_SETTING_KEYS.destinations, value },
      update: { value },
    }),
    prisma.setting.deleteMany({ where: { key: { in: Object.values(LEGACY_OTEL_DESTINATION_KEYS) } } }),
  ]);
  // Apply in this process now; the worker and integrations pick it up on their next poll.
  await reloadTelemetry().catch(() => {});

  return NextResponse.json({ destinations: maskDestinations(destinations) });
}
