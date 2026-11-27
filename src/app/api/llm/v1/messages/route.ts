import type Anthropic from "@anthropic-ai/sdk";
import { runAnthropicRequest } from "@/lib/llm-gateway/backends";
import {
  authenticateGateway, describeError, errorResponse, linkAbort, readJson, resolveGatewayProvider, sseResponse,
} from "@/lib/llm-gateway/http";
import { GatewayCall } from "@/lib/llm-gateway/telemetry";
import { AnthropicStreamUsage, anthropicMessageUsage } from "@/lib/gen-ai-telemetry";

// Anthropic-compatible Messages API, run on the API key's provider (default chain unless the key picks one).
// Point an Anthropic client at `<origin>/api/llm` with a task manager API key.
// See src/lib/llm-gateway/backends.ts.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const apiKey = await authenticateGateway(req, "anthropic");
  if (apiKey instanceof Response) return apiKey;

  const body = await readJson<Anthropic.MessageCreateParams>(req, "anthropic");
  if (body instanceof Response) return body;
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return errorResponse("anthropic", 400, "messages: must be a non-empty array.");
  }

  const provider = await resolveGatewayProvider("anthropic", apiKey);
  if (provider instanceof Response) return provider;

  const abort = linkAbort(req);
  const call = new GatewayCall("anthropic", provider, body, apiKey);
  try {
    const result = await call.run(() => runAnthropicRequest(provider, body, {
      signal: abort.signal,
      anthropicBeta: req.headers.get("anthropic-beta"),
    }));
    if ("stream" in result) return sseResponse("anthropic", call.observe(result.stream, new AnthropicStreamUsage()), abort);
    call.succeed(anthropicMessageUsage(result.message));
    return Response.json(result.message);
  } catch (err) {
    call.fail(err);
    const { status, message } = describeError(err);
    return errorResponse("anthropic", status, message);
  }
}
