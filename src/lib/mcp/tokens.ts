// MCP access tokens (Settings -> MCP). Pure helpers — no DB access — so they can be
// unit-tested; the route-side lookup lives in src/lib/mcp/auth.ts.
//
// Tokens look like `tm_mcp_<48 hex chars>`. As with public API keys (src/lib/api-keys.ts)
// only the SHA-256 hash is persisted; the plaintext is shown once at creation time.
// The distinct prefix keeps the two credential types apart: an MCP token is never
// accepted by /api/v1/* and an API key is never accepted by /api/mcp.
import { randomBytes } from "crypto";
import { hashApiKey } from "@/lib/api-keys";

export const MCP_TOKEN_PREFIX = "tm_mcp_";

/**
 * What a token may do. "read" sees only read-only tools; "write" sees every tool.
 * Write implies read — there's no write-only token, because almost every write
 * (edit a task, review it) starts by looking the task up.
 */
export type McpAccess = "read" | "write";

export const MCP_ACCESS_LEVELS: readonly McpAccess[] = ["read", "write"];

export const MCP_ACCESS_LABELS: Record<McpAccess, string> = {
  read: "Read only",
  write: "Read & write",
};

export function isMcpAccess(v: unknown): v is McpAccess {
  return v === "read" || v === "write";
}

/** Anything unrecognised falls back to the safer "read". */
export function normalizeMcpAccess(v: unknown): McpAccess {
  return isMcpAccess(v) ? v : "read";
}

/** Whether a token with `granted` access may use a tool that requires `required`. */
export function accessAllows(granted: McpAccess, required: McpAccess): boolean {
  return required === "read" || granted === "write";
}

export function hashMcpToken(token: string): string {
  return hashApiKey(token);
}

/** Short, non-secret identifier shown in the UI, e.g. "tm_mcp_ab12…ff90". */
export function previewMcpToken(token: string): string {
  const body = token.slice(MCP_TOKEN_PREFIX.length);
  return `${MCP_TOKEN_PREFIX}${body.slice(0, 4)}…${body.slice(-4)}`;
}

export function generateMcpToken(): { token: string; keyHash: string; keyPrefix: string } {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  return { token, keyHash: hashMcpToken(token), keyPrefix: previewMcpToken(token) };
}

/** Pulls the bearer token out of an Authorization header value, or null. */
export function extractBearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}
