import type OpenAI from "openai";
import { runOpenAIRequest } from "@/lib/llm-gateway/backends";
import {
  authenticateGateway, describeError, errorResponse, linkAbort, readJson, resolveGatewayProvider, sseResponse,
} from "@/lib/llm-gateway/http";
import { GatewayCall } from "@/lib/llm-gateway/telemetry";
import { OpenAIStreamUsage, openaiCompletionUsage } from "@/lib/gen-ai-telemetry";

// OpenAI-compatible Chat Completions, run on the API key's provider (default chain unless the key picks one).
// Point an OpenAI client at `<origin>/api/llm/v1` with a task manager API key.
// See src/lib/llm-gateway/backends.ts.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const apiKey = await authenticateGateway(req, "openai");
  if (apiKey instanceof Response) return apiKey;

  const body = await readJson<OpenAI.Chat.ChatCompletionCreateParams>(req, "openai");
  if (body instanceof Response) return body;
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return errorResponse("openai", 400, "'messages' must be a non-empty array.");
  }

  const provider = await resolveGatewayProvider("openai", apiKey);
  if (provider instanceof Response) return provider;

  const abort = linkAbort(req);
  const call = new GatewayCall("openai", provider, body, apiKey);
  try {
    const result = await call.run(() => runOpenAIRequest(provider, body, { signal: abort.signal }));
    if ("stream" in result) return sseResponse("openai", call.observe(result.stream, new OpenAIStreamUsage()), abort);
    call.succeed(openaiCompletionUsage(result.completion));
    return Response.json(result.completion);
  } catch (err) {
    call.fail(err);
    const { status, message } = describeError(err);
    return errorResponse("openai", status, message);
  }
}
