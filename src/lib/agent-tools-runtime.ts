/**
 * Worker-side half of agent tool access (see src/lib/agent-tools.ts for the model).
 *
 * `prepareAgentTools()` reads the settings, resolves which tools a task may use,
 * and produces:
 *   - an env overlay every provider applies to the agent it spawns (tokens for
 *     granted tools; credentials stripped + a PATH shim for denied ones),
 *   - a prompt section telling the agent what it can and can't use,
 *   - a cleanup function removing the per-run temp dir.
 *
 * The shim is what makes "denied" hold even when the worker host has its own
 * `gh auth login`: `gh` on PATH resolves to a script that explains access
 * wasn't granted, and GH_CONFIG_DIR points at an empty dir so calling the real
 * binary by absolute path finds no stored login either.
 */
import { prisma } from "@/lib/db";
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  AGENT_TOOL_DEFAULTS_KEY,
  GITHUB_CLI_TOOL_ID,
  buildToolAccessPrompt,
  emptyEnvOverlay,
  resolveToolAccess,
  type AgentEnvOverlay,
  type AgentToolDef,
} from "@/lib/agent-tools";

export interface PreparedAgentTools {
  env: AgentEnvOverlay;
  promptSection: string;
  /** One line per tool for the task log, e.g. "GitHub CLI: granted (task)". */
  summary: string[];
  cleanup: () => Promise<void>;
}

export interface GitHubCliSettings {
  token: string | null;
  /** Where the token came from, for display. */
  tokenSource: "dedicated" | "git" | null;
  useGitToken: boolean;
}

export async function loadGitHubCliSettings(): Promise<GitHubCliSettings> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["github_cli_token", "github_cli_use_git_token", "git_access_token", "git_provider"] } },
  });
  const map = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  const useGitToken = map.github_cli_use_git_token === "true";
  const dedicated = map.github_cli_token?.trim();
  if (dedicated) return { token: dedicated, tokenSource: "dedicated", useGitToken };
  const gitIsGithub = (map.git_provider ?? "github") === "github";
  const gitToken = map.git_access_token?.trim();
  if (useGitToken && gitIsGithub && gitToken) return { token: gitToken, tokenSource: "git", useGitToken };
  return { token: null, tokenSource: null, useGitToken };
}

export async function loadAgentToolDefaults(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: AGENT_TOOL_DEFAULTS_KEY } });
  return row?.value ?? null;
}

let ghPathCache: { at: number; path: string | null } | null = null;

/** Absolute path of the real `gh` binary, or null when it isn't installed. Cached for a minute. */
export async function findGhBinary(): Promise<string | null> {
  if (ghPathCache && Date.now() - ghPathCache.at < 60_000) return ghPathCache.path;
  const candidates = [process.env.GH_PATH, "/usr/local/bin/gh", "/usr/bin/gh", "/opt/homebrew/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"].filter(Boolean) as string[];
  let found: string | null = null;
  for (const c of candidates) {
    try {
      await fs.access(c, fs.constants.X_OK);
      found = c;
      break;
    } catch { /* keep looking */ }
  }
  if (!found) {
    found = await new Promise<string | null>((resolve) => {
      execFile("sh", ["-c", "command -v gh"], { timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      });
    });
  }
  ghPathCache = { at: Date.now(), path: found };
  return found;
}

/** `gh --version` first line, or null when not installed. */
export async function ghVersion(): Promise<string | null> {
  const bin = await findGhBinary();
  if (!bin) return null;
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.split("\n")[0]?.trim() || null);
    });
  });
}

function denyShim(tool: AgentToolDef): string {
  const msg = `${tool.command}: ${tool.name} access has not been granted for this task. Enable it for the task (Advanced Options → Tool Access) or by default in Settings → Agent Tools.`;
  return `#!/bin/sh\necho '${msg.replace(/'/g, "'\\''")}' >&2\nexit 1\n`;
}

/**
 * Resolve and prepare tool access for one agent run. Never throws for a
 * misconfigured tool — it's reported in the summary/prompt and treated as
 * unavailable — but does throw if the temp dir can't be created, since running
 * without the deny shims would silently widen access.
 */
export async function prepareAgentTools(taskId: string, taskToolAccess: string | null | undefined): Promise<PreparedAgentTools> {
  const defaults = await loadAgentToolDefaults();
  const resolved = resolveToolAccess(taskToolAccess, defaults);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ctm-tools-${taskId.slice(0, 12)}-`));
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });

  const env = emptyEnvOverlay();
  const summary: string[] = [];
  const promptEntries: Parameters<typeof buildToolAccessPrompt>[0] = [];
  let needsBinDir = false;

  for (const { tool, granted, source } of resolved) {
    // Whatever happens below, never let the worker's own credentials for this tool
    // leak through: a granted tool re-sets them from its own settings.
    env.unset.push(...tool.credentialEnv);

    if (tool.id === GITHUB_CLI_TOOL_ID) {
      // Isolate from any `gh auth login` on the worker host, granted or not.
      const ghConfig = path.join(root, "gh-config");
      await fs.mkdir(ghConfig, { recursive: true });
      env.set.GH_CONFIG_DIR = ghConfig;
      env.set.GH_PROMPT_DISABLED = "1";
      env.set.GH_NO_UPDATE_NOTIFIER = "1";

      if (granted) {
        const [settings, bin] = await Promise.all([loadGitHubCliSettings(), findGhBinary()]);
        if (!bin) {
          summary.push(`${tool.name}: granted (${source}) but \`gh\` is not installed on the worker`);
          promptEntries.push({ tool, granted, available: false, note: "`gh` is not installed" });
        } else if (!settings.token) {
          summary.push(`${tool.name}: granted (${source}) but no token is configured in Settings → Agent Tools`);
          promptEntries.push({ tool, granted, available: false, note: "no GitHub token configured" });
        } else {
          env.set.GH_TOKEN = settings.token;
          env.set.GITHUB_TOKEN = settings.token;
          summary.push(`${tool.name}: granted (${source}, ${settings.tokenSource === "git" ? "Git settings token" : "dedicated token"})`);
          promptEntries.push({
            tool,
            granted,
            available: true,
            note: "Run it from inside a cloned repo directory (or pass `--repo owner/name`) so it targets the right repository. Never print the token.",
          });
        }
        continue;
      }
    }

    if (!granted) {
      await fs.writeFile(path.join(binDir, tool.command), denyShim(tool), { mode: 0o755 });
      needsBinDir = true;
      summary.push(`${tool.name}: not granted (${source})`);
      promptEntries.push({ tool, granted, available: false });
    }
  }

  if (needsBinDir) env.prependPath.push(binDir);

  return {
    env,
    promptSection: buildToolAccessPrompt(promptEntries),
    summary,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
