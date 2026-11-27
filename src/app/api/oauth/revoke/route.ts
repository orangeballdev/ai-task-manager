import { NextRequest, NextResponse } from "next/server";
import { parseTokenRequestBody, readClientCredentials } from "@/lib/mcp/oauth";
import { authenticateOAuthClient, revokeOAuthToken } from "@/lib/mcp/oauth-store";
import { OAUTH_CORS_HEADERS, oauthErrorResponse, oauthPreflight } from "@/lib/mcp/oauth-http";

// RFC 7009 token revocation — called by MCP clients when the user logs out of the server.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = parseTokenRequestBody(req.headers.get("content-type"), await req.text());
    const client = await authenticateOAuthClient(readClientCredentials(req.headers.get("authorization"), body));
    await revokeOAuthToken(client, body.token);
    return new NextResponse(null, { status: 200, headers: OAUTH_CORS_HEADERS });
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const OPTIONS = oauthPreflight;
