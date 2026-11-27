import { NextRequest } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";
import { oauthJson, oauthPreflight } from "@/lib/mcp/oauth-http";
import { requestOrigin } from "@/lib/request-origin";

// RFC 8414 authorization server metadata (the app is its own authorization server for MCP
// clients). The catch-all also answers path-suffixed lookups such as
// /.well-known/oauth-authorization-server/api/mcp, which some clients try first.
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return oauthJson(authorizationServerMetadata(requestOrigin(req)), 200, { "Cache-Control": "public, max-age=300" });
}

export const OPTIONS = oauthPreflight;
