import "@/lib/otel-preload";
import { prisma } from "@/lib/db";
import { initTelemetry } from "@/lib/otel";

export async function startTelemetry(): Promise<void> {
  try {
    await initTelemetry({
      role: "app",
      loadSettings: async () => {
        const rows: { key: string; value: string }[] = await prisma.setting.findMany();
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
      },
    });
  } catch (err) {
    console.error("[otel] Failed to initialise telemetry:", err);
  }
}
