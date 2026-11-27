import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { KeyRound, ShieldAlert } from "lucide-react";
import { buildRedirect, checkAuthorizeRequest, readAuthorizeParams } from "@/lib/mcp/oauth";
import { findOAuthClient } from "@/lib/mcp/oauth-store";
import { MCP_ACCESS_LABELS, MCP_ACCESS_LEVELS } from "@/lib/mcp/tokens";
import { requestOrigin } from "@/lib/request-origin";

// OAuth consent page for MCP clients (authorization endpoint, GET). The request is validated
// here and again when the form posts to /api/oauth/authorize, which issues the code.
// The proxy (src/proxy.ts) requires a signed-in session here, so only someone who can sign
// in — the same people who can create tokens in Settings → MCP — can approve a client.
export const dynamic = "force-dynamic";
export const metadata = { title: "Authorize MCP client" };

const ACCESS_HELP = {
  read: "List, search and inspect tasks, logs, output files and stats. Can't change anything.",
  write: "Everything read-only can, plus create, edit, start, cancel, message and review tasks.",
} as const;

function describeRedirect(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" || u.protocol === "https:") return u.host;
    return `${u.protocol}//`;
  } catch {
    return uri;
  }
}

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = readAuthorizeParams((k) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  });
  const origin = requestOrigin({ headers: await headers() });
  const client = await findOAuthClient(params.clientId);
  const check = checkAuthorizeRequest(params, client, origin);

  if (check.kind === "redirect_error") {
    redirect(
      buildRedirect(check.redirectUri, {
        error: check.error,
        error_description: check.description,
        state: params.state ?? undefined,
        iss: origin,
      }),
    );
  }

  if (check.kind === "fatal" || !client) {
    return (
      <div className="max-w-lg mx-auto py-12">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="size-4 text-destructive" /> Can&apos;t authorize this client
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {check.kind === "fatal" ? check.message : "Unknown client."}
          </CardContent>
        </Card>
      </div>
    );
  }

  const hidden: Record<string, string | null> = {
    response_type: "code",
    client_id: client.id,
    redirect_uri: check.redirectUri,
    state: params.state,
    scope: params.scope,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    resource: params.resource,
  };

  return (
    <div className="max-w-lg mx-auto py-12">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4 text-muted-foreground" /> Connect {client.name} to AI Task Manager?
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form method="post" action="/api/oauth/authorize" className="flex flex-col gap-5">
            {Object.entries(hidden).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}

            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{client.name}</span> wants to use this Task Manager
              through its MCP server. Approving signs it in; you&apos;ll be sent back to{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">{describeRedirect(check.redirectUri)}</code>.
            </p>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium mb-2">Access</legend>
              {MCP_ACCESS_LEVELS.map((a) => (
                <label key={a} className="flex items-start gap-3 rounded-md border border-border px-3 py-2 cursor-pointer has-[:checked]:border-primary">
                  <input type="radio" name="access" value={a} defaultChecked={a === check.requestedAccess} className="mt-1" />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{MCP_ACCESS_LABELS[a]}</span>
                    <span className="text-xs text-muted-foreground">{ACCESS_HELP[a]}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <p className="text-xs text-muted-foreground">
              The connection appears under Settings → MCP, where you can change its access or revoke it at any time.
              Only approve clients you started signing in from yourself.
            </p>

            <div className="flex gap-2 justify-end">
              <button type="submit" name="decision" value="deny" className={buttonVariants({ variant: "outline" })}>
                Deny
              </button>
              <button type="submit" name="decision" value="approve" className={buttonVariants({ variant: "default" })}>
                Approve
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
