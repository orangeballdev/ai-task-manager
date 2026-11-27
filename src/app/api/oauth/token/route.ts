import { NextRequest } from "next/server";
import { parseTokenRequestBody, readClientCredentials } from "@/lib/mcp/oauth";
import {
  OAuthError,
  authenticateOAuthClient,
  exchangeAuthorizationCode,
  refreshGrant,
} from "@/lib/mcp/oauth-store";
import { oauthErrorResponse, oauthJson, oauthPreflight } from "@/lib/mcp/oauth-http";

// OAuth token endpoint for MCP clients: authorization_code (with PKCE) and refresh_token.
// The access token it returns is a `tm_mcp_…` MCP token — see src/lib/mcp/oauth.ts.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = parseTokenRequestBody(req.headers.get("content-type"), await req.text());
    const client = await authenticateOAuthClient(readClientCredentials(req.headers.get("authorization"), body));

    switch (body.grant_type) {
      case "authorization_code":
        return oauthJson(
          await exchangeAuthorizationCode(client, {
            code: body.code,
            redirectUri: body.redirect_uri,
            codeVerifier: body.code_verifier,
          }),
        );
      case "refresh_token":
        return oauthJson(await refreshGrant(client, body.refresh_token));
      case undefined:
      case "":
        throw new OAuthError("invalid_request", "grant_type is required");
      default:
        throw new OAuthError("unsupported_grant_type", `grant_type "${body.grant_type}" is not supported`);
    }
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const OPTIONS = oauthPreflight;
