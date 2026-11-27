import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// A worker is considered alive if it has written a heartbeat within the last 30 seconds.
// The worker updates `worker_last_seen` on every poll cycle (~5s).
const ALIVE_THRESHOLD_MS = 30_000;

export async function GET() {
  const setting = await prisma.setting.findUnique({ where: { key: "worker_last_seen" } });
  const lastSeen = setting?.value ?? null;
  const alive = lastSeen
    ? Date.now() - new Date(lastSeen).getTime() < ALIVE_THRESHOLD_MS
    : false;
  return NextResponse.json({ alive, lastSeen });
}
