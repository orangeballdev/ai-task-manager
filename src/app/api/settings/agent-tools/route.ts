import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AGENT_TOOLS, AGENT_TOOL_DEFAULTS_KEY, normalizeToolAccess } from "@/lib/agent-tools";
import { ghVersion, loadAgentToolDefaults } from "@/lib/agent-tools-runtime";

/**
 * Settings → Agent Tools backing API.
 *
 * GET  — the tool registry, which tools are granted by default, and per-tool
 *        status (credentials configured? binary installed?). Never returns secrets.
 * POST — `{ defaults: { [toolId]: boolean } }` merges into the stored defaults.
 */
export async function GET() {
  const [defaultsRaw, rows, version] = await Promise.all([
    loadAgentToolDefaults(),
    prisma.setting.findMany({
      where: { key: { in: ["github_cli_token", "github_cli_use_git_token", "git_access_token", "git_provider"] } },
    }),
    ghVersion(),
  ]);
  const map = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  const defaults = normalizeToolAccess(defaultsRaw);
  const gitTokenAvailable = Boolean(map.git_access_token?.trim()) && (map.git_provider ?? "github") === "github";
  const dedicatedToken = Boolean(map.github_cli_token?.trim());
  const useGitToken = map.github_cli_use_git_token === "true";

  return NextResponse.json({
    tools: AGENT_TOOLS.map((t) => ({
      id: t.id,
      name: t.name,
      command: t.command,
      description: t.description,
      settingsAnchor: t.settingsAnchor,
      grantedByDefault: defaults[t.id] === true,
    })),
    github: {
      installed: version !== null,
      version,
      dedicatedToken,
      useGitToken,
      gitTokenAvailable,
      // Whether a granted task would actually get a usable token.
      ready: version !== null && (dedicatedToken || (useGitToken && gitTokenAvailable)),
    },
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { defaults?: unknown } | null;
  if (!body || typeof body.defaults !== "object" || body.defaults === null) {
    return NextResponse.json({ error: "defaults is required" }, { status: 400 });
  }
  const current = normalizeToolAccess(await loadAgentToolDefaults());
  const next = { ...current, ...normalizeToolAccess(body.defaults) };
  await prisma.setting.upsert({
    where: { key: AGENT_TOOL_DEFAULTS_KEY },
    create: { key: AGENT_TOOL_DEFAULTS_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return NextResponse.json({ ok: true, defaults: next });
}
