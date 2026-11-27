import { NextRequest } from "next/server";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";
import { oauthJson, oauthPreflight } from "@/lib/mcp/oauth-http";
import { requestOrigin } from "@/lib/request-origin";

// RFC 9728 protected resource metadata for the MCP endpoint. Served both at the root and at
// the path-suffixed /.well-known/oauth-protected-resource/api/mcp that /api/mcp's 401 names.
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return oauthJson(protectedResourceMetadata(requestOrigin(req)), 200, { "Cache-Control": "public, max-age=300" });
}

export const OPTIONS = oauthPreflight;
