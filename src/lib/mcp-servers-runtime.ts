/**
 * Worker-side half of external MCP servers (see src/lib/mcp-servers.ts).
 *
 * `prepareMcpServers()` loads the enabled servers from Settings → MCP Servers and
 * turns them into what the task's provider needs:
 *   - Claude CLI: a `--mcp-config` JSON file in a private (0700) per-run temp dir,
 *     so the env/header secrets never land in the workspace or a repo,
 *   - Codex CLI: `--config mcp_servers.<name>.…` overrides,
 * plus a prompt section and a log summary. API-based providers run their own tool
 * loop and can't use MCP servers, so they get nothing (and a log line saying so).
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { prisma } from "@/lib/db";
import {
  buildClaudeMcpConfig,
  buildCodexMcpArgs,
  buildMcpServersPrompt,
  providerSupportsMcp,
  rowToConfig,
  type AgentMcpConfig,
  type McpServerConfig,
} from "@/lib/mcp-servers";

export interface PreparedMcpServers {
  mcp: AgentMcpConfig | undefined;
  promptSection: string;
  /** Single line for the task log, or "" when there's nothing to say. */
  summary: string;
  cleanup: () => Promise<void>;
}

const NOOP = async () => {};

export async function loadEnabledMcpServers(): Promise<McpServerConfig[]> {
  const rows = await prisma.mcpServer.findMany({ where: { enabled: true }, orderBy: { name: "asc" } });
  return rows.map(rowToConfig);
}

export async function prepareMcpServers(taskId: string, providerType: string): Promise<PreparedMcpServers> {
  const servers = await loadEnabledMcpServers();
  if (servers.length === 0) return { mcp: undefined, promptSection: "", summary: "", cleanup: NOOP };

  const names = servers.map((s) => s.name).join(", ");
  if (!providerSupportsMcp(providerType)) {
    return {
      mcp: undefined,
      promptSection: "",
      summary: `MCP servers not attached — the ${providerType} provider doesn't support MCP (only the Claude CLI and Codex CLI do). Configured: ${names}`,
      cleanup: NOOP,
    };
  }

  if (providerType === "codex-cli") {
    const { args, skipped } = buildCodexMcpArgs(servers);
    const used = servers.filter((s) => !skipped.includes(s.name));
    return {
      mcp: args.length > 0 ? { codexArgs: args } : undefined,
      promptSection: buildMcpServersPrompt(used),
      summary: [
        used.length > 0 ? `MCP servers: ${used.map((s) => s.name).join(", ")}` : "",
        skipped.length > 0 ? `skipped (Codex doesn't support SSE servers): ${skipped.join(", ")}` : "",
      ].filter(Boolean).join(" | "),
      cleanup: NOOP,
    };
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ctm-mcp-${taskId.slice(0, 12)}-`));
  const file = path.join(root, "mcp.json");
  await fs.writeFile(file, JSON.stringify(buildClaudeMcpConfig(servers), null, 2), { mode: 0o600 });
  return {
    mcp: { claudeConfigPath: file },
    promptSection: buildMcpServersPrompt(servers),
    summary: `MCP servers: ${names}`,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
