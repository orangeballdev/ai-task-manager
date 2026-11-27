import { NextResponse } from "next/server";
import { GATEWAY_PAUSE_DURATIONS, serializeGatewayPause } from "@/lib/llm-gateway/pause";
import { getGatewayPause, pauseGateway, resumeGateway } from "@/lib/llm-gateway/pause-store";

// Temporarily disable / re-enable the LLM gateway (/api/llm/v1/*). Session-protected like every
// non-public route (src/proxy.ts). While paused, gateway requests get a 503 in their API's own
// error shape (see authenticateGateway() in src/lib/llm-gateway/http.ts).
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(serializeGatewayPause(await getGatewayPause()));
}

/** Body: `{ duration: "15m" | "1h" | "4h" | "24h" | "7d" | "indefinite" }`. */
export async function PUT(req: Request) {
  let body: { duration?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const state = await pauseGateway(body?.duration);
  if (!state) {
    return NextResponse.json(
      { error: `duration must be one of: ${GATEWAY_PAUSE_DURATIONS.map((d) => d.id).join(", ")}` },
      { status: 400 },
    );
  }
  return NextResponse.json(serializeGatewayPause(state));
}

export async function DELETE() {
  await resumeGateway();
  return NextResponse.json(serializeGatewayPause({ paused: false }));
}
