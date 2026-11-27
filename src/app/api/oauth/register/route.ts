import { NextRequest } from "next/server";
import { parseClientRegistration } from "@/lib/mcp/oauth";
import { registerOAuthClient } from "@/lib/mcp/oauth-store";
import { oauthErrorResponse, oauthJson, oauthPreflight } from "@/lib/mcp/oauth-http";

// RFC 7591 dynamic client registration — how MCP clients (Claude Code, Claude Desktop, Codex…)
// obtain a client_id before sending the user to /oauth/authorize. Open by design, as the MCP
// spec expects: a registration grants nothing until a user approves it on the consent page.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = parseClientRegistration(body);
  if (!parsed.ok) return oauthJson({ error: parsed.error, error_description: parsed.description }, 400);

  try {
    const { client, clientSecret, createdAt } = await registerOAuthClient(parsed.client);
    return oauthJson(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(createdAt.getTime() / 1000),
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_name: client.name,
        ...(client.clientUri ? { client_uri: client.clientUri } : {}),
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      },
      201,
    );
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const OPTIONS = oauthPreflight;
