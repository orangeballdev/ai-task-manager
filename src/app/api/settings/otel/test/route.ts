import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  MASKED_HEADERS,
  normalizeStoredDestination,
  parseOtelSettings,
  readStoredDestinations,
  resolveDestination,
} from "@/lib/otel-config";
import { testOtelExport } from "@/lib/otel";

/**
 * Sends one test span, metric and log record to one destination, described by
 * the posted form values (so it can be tested before being saved or switched
 * on). Headers still set to the mask mean "use this destination's saved headers".
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { destination?: unknown };
  const posted = normalizeStoredDestination(body.destination);
  if (!posted) return NextResponse.json({ ok: false, error: "No destination to test." }, { status: 400 });

  const rows = await prisma.setting.findMany({ where: { key: { startsWith: "otel_" } } });
  const settings = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  if (posted.headers === MASKED_HEADERS) {
    posted.headers = readStoredDestinations(settings).find((d) => d.id === posted.id)?.headers ?? "";
  }
  if (!posted.traces && !posted.metrics && !posted.logs) {
    return NextResponse.json({ ok: false, error: "Enable at least one signal for this destination to test." }, { status: 400 });
  }

  const results = await testOtelExport(parseOtelSettings(settings), resolveDestination(posted));
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}
