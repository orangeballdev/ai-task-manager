import { NextRequest, NextResponse } from "next/server";
import { ghVersion, loadGitHubCliSettings } from "@/lib/agent-tools-runtime";

/**
 * Check the token the GitHub CLI would run with. Accepts an unsaved `token` so the
 * user can verify before saving; otherwise uses exactly what the worker would
 * (dedicated token, else the Git settings token when "reuse" is on).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const inline = body.token?.trim();
  const settings = inline ? null : await loadGitHubCliSettings();
  const token = inline || settings?.token;
  const version = await ghVersion();

  if (!token) {
    return NextResponse.json({ ok: false, error: "No token configured", ghInstalled: version !== null, ghVersion: version });
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Token rejected by GitHub (${res.status})`, ghInstalled: version !== null, ghVersion: version });
    }
    const user = (await res.json()) as { login: string; name: string | null };
    const scopeHeader = res.headers.get("x-oauth-scopes");
    const expiry = res.headers.get("github-authentication-token-expiration");
    return NextResponse.json({
      ok: true,
      user: { username: user.login, name: user.name ?? user.login },
      // Classic tokens report their scopes; fine-grained tokens don't send the header.
      tokenType: scopeHeader === null ? "fine-grained" : "classic",
      scopes: scopeHeader ? scopeHeader.split(",").map((s) => s.trim()).filter(Boolean) : [],
      expiresAt: expiry || null,
      source: inline ? "unsaved" : settings?.tokenSource,
      ghInstalled: version !== null,
      ghVersion: version,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Verification failed: ${err instanceof Error ? err.message : String(err)}`, ghInstalled: version !== null, ghVersion: version });
  }
}
