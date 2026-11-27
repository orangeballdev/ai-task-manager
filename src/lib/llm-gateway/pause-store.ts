/**
 * DB half of the LLM gateway pause (see pause.ts): reads/writes the `llm_gateway_paused_until`
 * Setting. Read on every gateway request — one indexed SQLite lookup — so pausing and
 * resuming take effect immediately, with no cache to invalidate across processes.
 */
import { prisma } from "@/lib/db";
import { GATEWAY_PAUSE_KEY, gatewayPauseValue, parseGatewayPause, type GatewayPauseState } from "./pause";

export async function getGatewayPause(now: Date = new Date()): Promise<GatewayPauseState> {
  const row = await prisma.setting.findUnique({ where: { key: GATEWAY_PAUSE_KEY } });
  return parseGatewayPause(row?.value, now);
}

/** Pauses for `duration` (see GATEWAY_PAUSE_DURATIONS). Returns null for an unknown duration. */
export async function pauseGateway(duration: unknown, now: Date = new Date()): Promise<GatewayPauseState | null> {
  const value = gatewayPauseValue(duration, now);
  if (!value) return null;
  await prisma.setting.upsert({
    where: { key: GATEWAY_PAUSE_KEY },
    create: { key: GATEWAY_PAUSE_KEY, value },
    update: { value },
  });
  return parseGatewayPause(value, now);
}

export async function resumeGateway(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: GATEWAY_PAUSE_KEY } });
}
