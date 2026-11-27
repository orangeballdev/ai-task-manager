import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

async function verifyGitHub(token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const userRes = await fetch("https://api.github.com/user", { headers });
  if (!userRes.ok) {
    return { ok: false, error: `Token rejected by GitHub (${userRes.status})` };
  }
  const user = await userRes.json() as { login: string; name: string | null; email: string | null };

  // Check scopes from response header
  const scopeHeader = userRes.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopeHeader ? scopeHeader.split(",").map((s) => s.trim()) : [];
  const hasWriteRepo = scopes.some((s) => ["repo", "public_repo"].includes(s)) || scopes.length === 0;

  return {
    ok: true,
    user: { username: user.login, name: user.name ?? user.login, email: user.email ?? undefined },
    scopes,
    hasWriteRepo,
    expiresAt: null,
    isBot: false,
  };
}

async function verifyGitLab(token: string, baseUrl: string) {
  if (!baseUrl) return { ok: false, error: "No GitLab base URL configured" };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = baseUrl.replace(/\/$/, "");

  const [userRes, tokenRes] = await Promise.all([
    fetch(`${base}/api/v4/user`, { headers }),
    fetch(`${base}/api/v4/personal_access_tokens/self`, { headers }),
  ]);

  if (!userRes.ok) {
    return { ok: false, error: `Token rejected by GitLab (${userRes.status})` };
  }

  const user = await userRes.json() as { username: string; name: string; email?: string; bot?: boolean };
  const isBot = user.bot === true || /project_\d+_bot/.test(user.username);

  let scopes: string[] = [];
  let expiresAt: string | null = null;
  if (tokenRes.ok) {
    const tokenInfo = await tokenRes.json() as { scopes: string[]; expires_at: string | null };
    scopes = tokenInfo.scopes ?? [];
    expiresAt = tokenInfo.expires_at ?? null;
  }

  const hasWriteRepo = scopes.some((s) => ["write_repository", "api"].includes(s));

  return {
    ok: !isBot && hasWriteRepo,
    user: { username: user.username, name: user.name, email: user.email },
    isBot,
    scopes,
    expiresAt,
    hasWriteRepo,
  };
}

export async function POST(req: NextRequest) {
  const { token: inlineToken, provider: inlineProvider, baseUrl: inlineBaseUrl } =
    await req.json() as { token?: string; provider?: string; baseUrl?: string };

  const settings = await prisma.setting.findMany({
    where: { key: { in: ["git_access_token", "git_provider", "git_base_url"] } },
  });
  const map = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));

  const token = inlineToken || map.git_access_token;
  const provider = inlineProvider || map.git_provider || "github";
  const baseUrl = (inlineBaseUrl || map.git_base_url || "").replace(/\/$/, "");

  if (!token) return NextResponse.json({ ok: false, error: "No token configured" });

  try {
    if (provider === "github") {
      return NextResponse.json(await verifyGitHub(token));
    } else {
      return NextResponse.json(await verifyGitLab(token, baseUrl));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Verification failed: ${msg}` });
  }
}
