import { NextRequest, NextResponse } from "next/server";
import { authenticateMcpRequest } from "@/lib/mcp/auth";
import { handleMcpPayload, parseErrorResponse } from "@/lib/mcp/protocol";
import { mcpServerConfig } from "@/lib/mcp/tools";
import { wwwAuthenticateHeader } from "@/lib/mcp/oauth";
import { requestOrigin } from "@/lib/request-origin";

// MCP server endpoint — Streamable HTTP transport, stateless.
//
// Every request is a POST carrying one JSON-RPC message (or a batch, for older
// clients) and is answered with a plain `application/json` body; we never open an SSE
// stream, so GET/DELETE return 405 as the spec allows. There are no sessions: each
// request authenticates on its own with `Authorization: Bearer tm_mcp_...` (a token from
// Settings → MCP, or an OAuth access token — src/lib/mcp/oauth.ts), and the
// token's access level ("read" / "write") decides which tools exist for that call.
// Protocol handling is src/lib/mcp/protocol.ts; the tools are src/lib/mcp/tools.ts.
// Setup instructions for clients live at /docs/mcp.
export const dynamic = "force-dynamic";

function unauthorized(req: NextRequest, message: string, invalidToken?: boolean) {
  // The resource_metadata pointer is how OAuth-capable clients (Claude Code, Claude Desktop,
  // Codex…) discover that they can sign in — see src/lib/mcp/oauth.ts.
  const header = wwwAuthenticateHeader(
    requestOrigin(req),
    invalidToken ? { code: "invalid_token", description: message } : undefined,
  );
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message } },
    { status: 401, headers: { "WWW-Authenticate": header } },
  );
}

export async function POST(req: NextRequest) {
  const auth = await authenticateMcpRequest(req.headers.get("authorization"));
  if (!auth.ok) return unauthorized(req, auth.message, auth.invalidToken);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(parseErrorResponse(), { status: 400 });
  }

  const response = await handleMcpPayload(payload, mcpServerConfig(), {
    access: auth.token.access,
    ctx: { tokenId: auth.token.id, tokenName: auth.token.name, origin: requestOrigin(req) },
  });

  // Notifications / client responses only — nothing to send back.
  if (response === null) return new NextResponse(null, { status: 202 });
  return NextResponse.json(response);
}

function methodNotAllowed() {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed. This MCP server only accepts POST (stateless Streamable HTTP)." } },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
