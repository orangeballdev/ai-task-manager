// Response helpers shared by the OAuth routes (metadata, register, token, revoke).
// These endpoints are called by MCP clients directly — sometimes from a browser
// (e.g. the MCP Inspector) — so they allow any origin; they never rely on cookies.
import { NextResponse } from "next/server";
import { OAuthError } from "./oauth-store";

export const OAUTH_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache", ...extra },
  });
}

export function oauthErrorResponse(err: unknown): NextResponse {
  if (err instanceof OAuthError) {
    const extra: Record<string, string> =
      err.status === 401 ? { "WWW-Authenticate": 'Basic realm="ai-task-manager-oauth"' } : {};
    return oauthJson({ error: err.error, error_description: err.description }, err.status, extra);
  }
  console.error("[oauth] unexpected error:", err);
  return oauthJson({ error: "server_error", error_description: "Internal error" }, 500);
}

export function oauthPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}
