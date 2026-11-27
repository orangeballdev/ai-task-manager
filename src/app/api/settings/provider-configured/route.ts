import { NextResponse } from "next/server";
import { getProvider } from "@/lib/smart-provider";

export async function GET() {
  // Resolve the same way real work does, so a disabled default provider doesn't report as
  // configured while every actual request against it fails.
  const { provider, throttledFallback } = await getProvider();

  // Rate-limited is not the same as unconfigured. The provider exists and works — it just has
  // no capacity right now — so callers must still be able to create tasks, which simply queue
  // until it resets. Only a genuine absence of any usable provider blocks work.
  if (!provider) {
    if (throttledFallback) {
      return NextResponse.json({
        configured: true,
        provider: throttledFallback.type,
        reason: "",
        throttledUntil: throttledFallback.throttledUntil?.toISOString() ?? null,
        throttledProviderName: throttledFallback.name,
      });
    }
    return NextResponse.json({
      configured: false,
      provider: null,
      reason: "No AI provider configured. Add one in Settings → AI.",
      throttledUntil: null,
      throttledProviderName: null,
    });
  }

  let configured = false;
  let reason = "";
  if (provider.type === "cli" || provider.type === "codex-cli") {
    configured = true;
  } else {
    configured = !!provider.apiKey;
    if (!configured) reason = `Provider "${provider.name}" has no API key. Edit it in Settings → AI.`;
  }

  return NextResponse.json({
    configured,
    provider: provider.type,
    reason,
    throttledUntil: null,
    throttledProviderName: null,
  });
}
