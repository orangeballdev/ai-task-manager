/**
 * Agent tool access — which external CLIs (and the credentials behind them) an agent
 * is allowed to use while it runs a task.
 *
 * This file is the *pure* half: the tool registry, how a task's per-tool overrides
 * combine with the global defaults, and how the resulting environment overlay is
 * applied to a spawned agent. It has no DB or filesystem access, so it is safe to
 * import from client components and is unit-tested
 * (src/lib/__tests__/agent-tools.test.ts). The worker-side half that reads settings
 * and prepares the on-disk shims is src/lib/agent-tools-runtime.ts.
 *
 * Model:
 *   - Settings → Agent Tools stores, per tool, whether it is granted by default
 *     (`agent_tool_defaults`, a JSON map of tool id → boolean) plus the tool's
 *     own credentials (e.g. `github_cli_token`).
 *   - A task may override any tool explicitly (`Task.toolAccess`, a JSON map of
 *     tool id → boolean). A tool missing from the map follows the default, so a
 *     change to the default applies to every task that didn't pick explicitly —
 *     including tasks already queued.
 *   - At run time a granted tool gets its credentials injected into the agent's
 *     environment; a denied tool gets its credentials *stripped* and its binary
 *     shadowed by a shim that explains access wasn't granted.
 *
 * Adding a tool (e.g. the AWS CLI) is: an entry in AGENT_TOOLS here, its secret
 * setting keys in `secretKeys` (masked by GET /api/settings automatically), a
 * branch in `buildToolEnv()` in agent-tools-runtime.ts, and a card on the
 * Settings → Agent Tools page. The task form and worker pick it up from the
 * registry with no further changes.
 */

export interface AgentToolDef {
  /** Stable id stored in settings and on tasks. Never rename. */
  id: string;
  /** Human name shown in the UI. */
  name: string;
  /** Binary the agent invokes (also the name of the shim installed when denied). */
  command: string;
  /** One-line description for the task form. */
  description: string;
  /** Setting keys that hold secrets for this tool. Masked in GET /api/settings. */
  secretKeys: string[];
  /**
   * Environment variables that carry this tool's credentials. Stripped from the
   * agent's environment whenever the tool is not granted, so a token the worker
   * process itself happens to have can't leak into a task that wasn't given access.
   */
  credentialEnv: string[];
  /** Settings page anchor for this tool's card. */
  settingsAnchor: string;
}

export const GITHUB_CLI_TOOL_ID = "github-cli";

export const AGENT_TOOLS: readonly AgentToolDef[] = [
  {
    id: GITHUB_CLI_TOOL_ID,
    name: "GitHub CLI",
    command: "gh",
    description: "Lets the agent run `gh` to create issues, comment on PRs, read workflow runs and more.",
    secretKeys: ["github_cli_token"],
    credentialEnv: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
    settingsAnchor: "github-cli",
  },
];

/** Setting key holding the JSON map of tool id → granted-by-default. */
export const AGENT_TOOL_DEFAULTS_KEY = "agent_tool_defaults";

/** Every secret setting key owned by an agent tool (for masking). */
export const AGENT_TOOL_SECRET_KEYS: string[] = AGENT_TOOLS.flatMap((t) => t.secretKeys);

export function getAgentTool(id: string): AgentToolDef | undefined {
  return AGENT_TOOLS.find((t) => t.id === id);
}

/** Tool id → true (granted) / false (denied). */
export type ToolAccessMap = Record<string, boolean>;

/**
 * Coerce any input (parsed JSON, API body, stored string) into a clean map that
 * only holds known tool ids with boolean values. Unknown ids and non-boolean
 * values are dropped rather than rejected, so a tool being removed from the
 * registry can never make old tasks unreadable.
 */
export function normalizeToolAccess(input: unknown): ToolAccessMap {
  let value = input;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      value = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ToolAccessMap = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!getAgentTool(key)) continue;
    if (v === true || v === "true" || v === "allow") out[key] = true;
    else if (v === false || v === "false" || v === "deny") out[key] = false;
  }
  return out;
}

/** Serialize a task's overrides for storage. An empty map is stored as null ("all defaults"). */
export function serializeToolAccess(input: unknown): string | null {
  const map = normalizeToolAccess(input);
  return Object.keys(map).length > 0 ? JSON.stringify(map) : null;
}

export type ToolAccessSource = "task" | "default";

export interface ResolvedToolAccess {
  tool: AgentToolDef;
  granted: boolean;
  source: ToolAccessSource;
}

/**
 * Combine a task's explicit overrides with the global defaults. Every registered
 * tool appears in the result exactly once. A tool with no default configured is
 * denied — access is always opt-in.
 */
export function resolveToolAccess(taskOverrides: unknown, defaults: unknown): ResolvedToolAccess[] {
  const overrides = normalizeToolAccess(taskOverrides);
  const defs = normalizeToolAccess(defaults);
  return AGENT_TOOLS.map((tool) => {
    if (tool.id in overrides) return { tool, granted: overrides[tool.id], source: "task" as const };
    return { tool, granted: defs[tool.id] === true, source: "default" as const };
  });
}

/**
 * Environment changes applied on top of the worker's own environment when an
 * agent is spawned. Kept declarative so every provider applies it the same way.
 */
export interface AgentEnvOverlay {
  /** Variables to set (win over anything inherited). */
  set: Record<string, string>;
  /** Variables to remove from the inherited environment. */
  unset: string[];
  /** Directories to put in front of PATH (used for "access denied" shims). */
  prependPath: string[];
}

export function emptyEnvOverlay(): AgentEnvOverlay {
  return { set: {}, unset: [], prependPath: [] };
}

/**
 * Apply an overlay to an environment. Unset runs first, then set, so a granted
 * tool's token survives even if another tool's cleanup lists the same variable.
 * Returns a new object; `base` is not modified.
 */
export function applyEnvOverlay<T extends Record<string, string | undefined>>(base: T, overlay?: AgentEnvOverlay | null): T {
  if (!overlay) return base;
  const env: Record<string, string | undefined> = { ...base };
  for (const key of overlay.unset) delete env[key];
  Object.assign(env, overlay.set);
  if (overlay.prependPath.length > 0) {
    env.PATH = [...overlay.prependPath, env.PATH ?? ""].filter(Boolean).join(":");
  }
  return env as T;
}

/**
 * Links that open GitHub's token-creation page with everything pre-filled, so the
 * user only has to pick an expiry/repos and click "Generate".
 *
 * - Fine-grained tokens accept the name, description and permissions as query
 *   parameters (`<permission>=read|write`).
 * - Classic tokens accept `scopes` and `description`.
 */
export function githubTokenLinks(): { fineGrained: string; classic: string } {
  const fine = new URLSearchParams({
    name: "AI Task Manager agent",
    description: "Used by AI Task Manager agents to run the GitHub CLI (gh).",
    contents: "read",
    issues: "write",
    pull_requests: "write",
    actions: "read",
    metadata: "read",
  });
  const classic = new URLSearchParams({
    scopes: "repo,read:org,workflow",
    description: "AI Task Manager agent (gh CLI)",
  });
  return {
    fineGrained: `https://github.com/settings/personal-access-tokens/new?${fine.toString()}`,
    classic: `https://github.com/settings/tokens/new?${classic.toString()}`,
  };
}

/**
 * The section appended to the agent's instructions describing what it may use.
 * Only mentions tools that are registered; granted tools come with usage notes,
 * denied ones with a one-line "don't". Returns "" when there is nothing to say.
 */
export function buildToolAccessPrompt(
  resolved: { tool: AgentToolDef; granted: boolean; available: boolean; note?: string }[],
): string {
  if (resolved.length === 0) return "";
  const lines: string[] = ["## External Tool Access", ""];
  for (const r of resolved) {
    if (r.granted && r.available) {
      lines.push(`- **${r.tool.name} (\`${r.tool.command}\`)**: GRANTED. It is already authenticated — do not run \`${r.tool.command} auth login\`.${r.note ? ` ${r.note}` : ""}`);
    } else if (r.granted) {
      lines.push(`- **${r.tool.name} (\`${r.tool.command}\`)**: granted but NOT usable in this environment${r.note ? ` (${r.note})` : ""}. Do not attempt to use it; mention in your summary if the task needed it.`);
    } else {
      lines.push(`- **${r.tool.name} (\`${r.tool.command}\`)**: NOT granted for this task. Do not use it or try to obtain credentials for it. If the task can't be completed without it, say so in your summary.`);
    }
  }
  return lines.join("\n");
}
