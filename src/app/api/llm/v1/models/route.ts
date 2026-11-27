import { getModelsForProviderType } from "@/lib/models";
import { authenticateGateway, resolveGatewayProvider } from "@/lib/llm-gateway/http";

// Model list for the gateway — `GET /v1/models` is the same path in both APIs, so each entry
// carries the fields both SDKs read (OpenAI: object/created/owned_by; Anthropic:
// type/display_name/created_at). Lists what the key's provider can run; `default` always
// means "the provider's configured model".
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const format = req.headers.get("anthropic-version") || req.headers.get("x-api-key") ? "anthropic" : "openai";
  const apiKey = await authenticateGateway(req, format);
  if (apiKey instanceof Response) return apiKey;

  const provider = await resolveGatewayProvider(format, apiKey);
  if (provider instanceof Response) return provider;

  const models = [{ id: "default", label: `${provider.name} default${provider.model ? ` (${provider.model})` : ""}` }];
  if (provider.model && !getModelsForProviderType(provider.type).some((m) => m.id === provider.model)) {
    models.push({ id: provider.model, label: provider.model });
  }
  models.push(...getModelsForProviderType(provider.type));

  const owner = provider.type === "openai" || provider.type === "codex-cli" ? "openai" : "anthropic";
  const created = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
  const data = models.map((m) => ({
    id: m.id,
    object: "model",
    type: "model",
    created,
    created_at: new Date(created * 1000).toISOString(),
    owned_by: owner,
    display_name: m.label,
  }));

  return Response.json({
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
}
