import type Anthropic from "@anthropic-ai/sdk";
import { countGatewayTokens } from "@/lib/llm-gateway/backends";
import {
  authenticateGateway, describeError, errorResponse, readJson, resolveGatewayProvider,
} from "@/lib/llm-gateway/http";

// Anthropic-compatible token counting. Exact on Claude API providers; an estimate elsewhere
// (subscription CLIs and OpenAI connections have no counting endpoint).
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const apiKey = await authenticateGateway(req, "anthropic");
  if (apiKey instanceof Response) return apiKey;

  const body = await readJson<Anthropic.MessageCountTokensParams>(req, "anthropic");
  if (body instanceof Response) return body;

  const provider = await resolveGatewayProvider("anthropic", apiKey);
  if (provider instanceof Response) return provider;

  try {
    return Response.json({ input_tokens: await countGatewayTokens(provider, body, req.headers.get("anthropic-beta")) });
  } catch (err) {
    const { status, message } = describeError(err);
    return errorResponse("anthropic", status, message);
  }
}
