import { NextRequest, NextResponse } from "next/server";
import { buildRedirect, checkAuthorizeRequest, readAuthorizeParams } from "@/lib/mcp/oauth";
import { createAuthorizationCode, findOAuthClient } from "@/lib/mcp/oauth-store";
import { normalizeMcpAccess } from "@/lib/mcp/tokens";
import { requestOrigin } from "@/lib/request-origin";

// Consent form target for /oauth/authorize. Re-validates the whole request (the form's hidden
// fields are user-controlled), then redirects back to the client with a code or access_denied.
export const dynamic = "force-dynamic";

function plain(message: string, status: number) {
  return new NextResponse(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * The approve button must be clicked on our own consent page — never submitted by another
 * site. Browsers send Sec-Fetch-Site and/or Origin with form posts, so a cross-site post is
 * refused; a client that sends neither (very old browsers) is let through.
 */
function isSameOrigin(req: NextRequest, origin: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const sent = req.headers.get("origin");
  if (!sent) return true;
  try {
    // Compare hosts only: behind a proxy that doesn't forward the scheme, our idea of the
    // protocol can differ from the browser's.
    return new URL(sent).host === new URL(origin).host;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const origin = requestOrigin(req);
  if (!isSameOrigin(req, origin)) return plain("Cross-site authorization requests are not allowed.", 403);

  const form = await req.formData().catch(() => null);
  if (!form) return plain("Expected a form submission.", 400);
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };

  const params = readAuthorizeParams(get);
  const client = await findOAuthClient(params.clientId);
  const check = checkAuthorizeRequest(params, client, origin);
  if (check.kind === "fatal") return plain(check.message, 400);

  const state = params.state ?? undefined;
  if (check.kind === "redirect_error") {
    return NextResponse.redirect(
      buildRedirect(check.redirectUri, { error: check.error, error_description: check.description, state, iss: origin }),
      303,
    );
  }

  if (get("decision") !== "approve") {
    return NextResponse.redirect(
      buildRedirect(check.redirectUri, {
        error: "access_denied",
        error_description: "The user denied the request",
        state,
        iss: origin,
      }),
      303,
    );
  }

  const code = await createAuthorizationCode({
    clientId: client!.id,
    redirectUri: check.redirectUri,
    codeChallenge: params.codeChallenge!,
    access: normalizeMcpAccess(get("access")),
    resource: params.resource,
  });
  return NextResponse.redirect(buildRedirect(check.redirectUri, { code, state, iss: origin }), 303);
}
