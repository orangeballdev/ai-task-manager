// Bearer-token authentication for the MCP endpoint (src/app/api/mcp/route.ts).
// Tokens are managed in Settings -> MCP; see src/lib/mcp/tokens.ts for the format.
import { prisma } from "@/lib/db";
import { API_KEY_PREFIX } from "@/lib/api-keys";
import { extractBearerToken, hashMcpToken, normalizeMcpAccess, type McpAccess } from "./tokens";

export interface AuthedMcpToken {
  id: string;
  name: string;
  access: McpAccess;
}

export type McpAuthResult =
  | { ok: true; token: AuthedMcpToken }
  /** `invalidToken`: a token was sent but is unknown/expired (RFC 6750 `error="invalid_token"`). */
  | { ok: false; message: string; invalidToken?: boolean };

export async function authenticateMcpRequest(authorization: string | null): Promise<McpAuthResult> {
  const raw = extractBearerToken(authorization);
  if (!raw) {
    return {
      ok: false,
      message:
        "No MCP token provided. Sign in with OAuth (most clients do this automatically), or send " +
        "'Authorization: Bearer tm_mcp_...' with a token from Settings → MCP.",
    };
  }
  if (raw.startsWith(API_KEY_PREFIX)) {
    return {
      ok: false,
      message: "That's a REST API key (tm_live_...). The MCP server needs an MCP token (tm_mcp_...) from Settings → MCP.",
    };
  }

  const row = await prisma.mcpToken.findUnique({ where: { keyHash: hashMcpToken(raw) } });
  if (!row) return { ok: false, message: "Invalid or revoked MCP token.", invalidToken: true };
  // Only OAuth access tokens expire; the client refreshes them at /api/oauth/token.
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
    return { ok: false, message: "MCP access token has expired.", invalidToken: true };
  }

  // Best-effort — auth must not fail because this write hiccups.
  prisma.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return { ok: true, token: { id: row.id, name: row.name, access: normalizeMcpAccess(row.access) } };
}
