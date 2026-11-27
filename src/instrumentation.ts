// Next.js calls register() once per server runtime before serving requests.
// OpenTelemetry export is configured in Settings → Observability (see
// src/lib/otel.ts); the SDK is Node-only, so it's loaded only in that runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTelemetry } = await import("./instrumentation.node");
    await startTelemetry();
  }
}
