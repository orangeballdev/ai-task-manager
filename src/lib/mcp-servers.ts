/**
 * External MCP servers made available to agents (Settings → MCP Servers).
 *
 * Not to be confused with src/lib/mcp/, which is the task manager's *own* MCP
 * endpoint that outside assistants connect to. This module is the other
 * direction: MCP servers (stdio commands or remote HTTP/SSE endpoints) that the
 * agents running tasks can call.
 *
 * Pure helpers only (validation, secret masking, CLI config builders, prompt
 * section) so they can be unit-tested; the worker half that loads rows and
 * writes the config file is src/lib/mcp-servers-runtime.ts.
 */

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: "Local command (stdio)",
  http: "Remote (Streamable HTTP)",
  sse: "Remote (SSE, legacy)",
};

/** Shown in place of env/header values in API responses. Sending it back means "keep the stored value". */
export const MCP_SECRET_MASK = "••••••••";

/**
 * Server names become config keys for both CLIs (`mcpServers.<name>` for Claude,
 * `mcp_servers.<name>` TOML keys for Codex) and the `mcp__<name>__<tool>` tool
 * prefix, so keep them to a safe charset.
 */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A server as handed to the agent CLIs. */
export interface McpServerConfig {
  name: string;
  description?: string | null;
  transport: McpTransport;
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  headers: Record<string, string>;
}

/** What a provider applies to the agent it spawns (set by the worker via createProvider()). */
export interface AgentMcpConfig {
  /** Path for `claude --mcp-config`. */
  claudeConfigPath?: string;
  /** Extra `codex exec` arguments. */
  codexArgs?: string[];
}

/** The DB row shape (JSON columns still serialized). */
export interface McpServerRow {
  id: string;
  name: string;
  description: string | null;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  headers: string;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export function isMcpTransport(v: unknown): v is McpTransport {
  return typeof v === "string" && (MCP_TRANSPORTS as readonly string[]).includes(v);
}

export function parseStringArray(raw: unknown): string[] {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function parseStringRecord(raw: unknown): Record<string, string> {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    name: row.name,
    description: row.description,
    transport: isMcpTransport(row.transport) ? row.transport : "stdio",
    command: row.command,
    args: parseStringArray(row.args),
    env: parseStringRecord(row.env),
    url: row.url,
    headers: parseStringRecord(row.headers),
  };
}

function maskRecord(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(r).map((k) => [k, MCP_SECRET_MASK]));
}

/** API-safe view of a row: JSON parsed, env/header values masked. */
export function toPublicMcpServer(row: McpServerRow) {
  const cfg = rowToConfig(row);
  return {
    id: row.id,
    name: cfg.name,
    description: cfg.description ?? null,
    transport: cfg.transport,
    command: cfg.command ?? null,
    args: cfg.args,
    env: maskRecord(cfg.env),
    url: cfg.url ?? null,
    headers: maskRecord(cfg.headers),
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export type PublicMcpServer = ReturnType<typeof toPublicMcpServer>;

/**
 * Merge an incoming secret map with the stored one: a value equal to the mask
 * keeps the stored value for that key, keys left out are removed.
 */
export function mergeSecrets(incoming: Record<string, string>, stored: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === MCP_SECRET_MASK) {
      if (k in stored) out[k] = stored[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Parse `KEY=value` (env) or `Header: value` (headers) lines from the settings
 * form. Blank lines and `#` comments are ignored. Returns the first bad line as
 * an error.
 */
export function parseKeyValueLines(text: string, kind: "env" | "headers"): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const sep = kind === "env" ? "=" : ":";
  const keyRe = kind === "env" ? ENV_KEY_RE : HEADER_KEY_RE;
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(sep);
    if (idx <= 0) return { ok: false, error: `Expected ${kind === "env" ? "KEY=value" : "Header: value"}, got "${line}"` };
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!keyRe.test(key)) return { ok: false, error: `Invalid ${kind === "env" ? "environment variable" : "header"} name "${key}"` };
    out[key] = value;
  }
  return { ok: true, value: out };
}

/** Inverse of parseKeyValueLines, for prefilling the edit form. */
export function formatKeyValueLines(r: Record<string, string>, kind: "env" | "headers"): string {
  const sep = kind === "env" ? "=" : ": ";
  return Object.entries(r).map(([k, v]) => `${k}${sep}${v}`).join("\n");
}

export interface McpServerData {
  name: string;
  description: string | null;
  transport: McpTransport;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  headers: string;
  enabled: boolean;
}

/**
 * Validate a create (no `existing`) or update (`existing` = stored row) body
 * from the API. For updates, fields left out keep their stored value; masked
 * secret values keep the stored secret.
 */
export function validateMcpServerInput(
  body: unknown,
  existing?: McpServerRow,
): { ok: true; data: McpServerData } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid body" };
  const b = body as Record<string, unknown>;
  const prev = existing ? rowToConfig(existing) : null;

  const name = b.name !== undefined ? (typeof b.name === "string" ? b.name.trim() : "") : prev?.name ?? "";
  if (!MCP_SERVER_NAME_RE.test(name)) {
    return { ok: false, error: "name is required and may only contain letters, numbers, '-' and '_' (max 64)" };
  }

  const transport = b.transport !== undefined ? b.transport : prev?.transport ?? "stdio";
  if (!isMcpTransport(transport)) return { ok: false, error: "transport must be 'stdio', 'http' or 'sse'" };

  const description = b.description !== undefined
    ? (typeof b.description === "string" && b.description.trim() ? b.description.trim() : null)
    : prev?.description ?? null;

  const enabled = b.enabled !== undefined ? b.enabled === true : existing?.enabled ?? true;

  let command: string | null = null;
  let args: string[] = [];
  let env: Record<string, string> = {};
  let url: string | null = null;
  let headers: Record<string, string> = {};

  if (transport === "stdio") {
    const rawCommand = b.command !== undefined ? b.command : prev?.command;
    command = typeof rawCommand === "string" ? rawCommand.trim() : "";
    if (!command) return { ok: false, error: "command is required for stdio servers" };
    if (b.args !== undefined) {
      if (!Array.isArray(b.args) || b.args.some((a) => typeof a !== "string")) return { ok: false, error: "args must be an array of strings" };
      args = b.args as string[];
    } else {
      args = prev?.args ?? [];
    }
    if (b.env !== undefined) {
      const incoming = parseStringRecord(b.env);
      for (const k of Object.keys(incoming)) {
        if (!ENV_KEY_RE.test(k)) return { ok: false, error: `Invalid environment variable name "${k}"` };
      }
      env = mergeSecrets(incoming, prev?.env ?? {});
    } else {
      env = prev?.env ?? {};
    }
  } else {
    const rawUrl = b.url !== undefined ? b.url : prev?.url;
    url = typeof rawUrl === "string" ? rawUrl.trim() : "";
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, error: "A valid url is required for remote servers" }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "url must be http(s)" };
    if (b.headers !== undefined) {
      const incoming = parseStringRecord(b.headers);
      for (const k of Object.keys(incoming)) {
        if (!HEADER_KEY_RE.test(k)) return { ok: false, error: `Invalid header name "${k}"` };
      }
      headers = mergeSecrets(incoming, prev?.headers ?? {});
    } else {
      headers = prev?.headers ?? {};
    }
  }

  return {
    ok: true,
    data: {
      name,
      description,
      transport,
      command,
      args: JSON.stringify(args),
      env: JSON.stringify(env),
      url,
      headers: JSON.stringify(headers),
      enabled,
    },
  };
}

/** The JSON passed to `claude --mcp-config <file>`. */
export function buildClaudeMcpConfig(servers: McpServerConfig[]): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    if (s.transport === "stdio") {
      if (!s.command) continue;
      mcpServers[s.name] = {
        type: "stdio",
        command: s.command,
        args: s.args,
        ...(Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      };
    } else {
      if (!s.url) continue;
      mcpServers[s.name] = {
        type: s.transport,
        url: s.url,
        ...(Object.keys(s.headers).length > 0 ? { headers: s.headers } : {}),
      };
    }
  }
  return { mcpServers };
}

// JSON string literals are valid TOML basic strings (same escapes), which is what
// Codex parses `--config key=value` values as.
const tomlString = (s: string) => JSON.stringify(s);
const tomlArray = (a: string[]) => `[${a.map(tomlString).join(", ")}]`;
const tomlTable = (r: Record<string, string>) =>
  `{ ${Object.entries(r).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(", ")} }`;

/**
 * `--config mcp_servers.<name>.…` overrides for `codex exec`. Codex supports
 * stdio and Streamable HTTP servers, but not legacy SSE — those are returned in
 * `skipped` so the worker can say so in the task log.
 */
export function buildCodexMcpArgs(servers: McpServerConfig[]): { args: string[]; skipped: string[] } {
  const args: string[] = [];
  const skipped: string[] = [];
  for (const s of servers) {
    const key = `mcp_servers.${s.name}`;
    if (s.transport === "stdio" && s.command) {
      args.push("--config", `${key}.command=${tomlString(s.command)}`);
      args.push("--config", `${key}.args=${tomlArray(s.args)}`);
      if (Object.keys(s.env).length > 0) args.push("--config", `${key}.env=${tomlTable(s.env)}`);
    } else if (s.transport === "http" && s.url) {
      args.push("--config", `${key}.url=${tomlString(s.url)}`);
      if (Object.keys(s.headers).length > 0) args.push("--config", `${key}.http_headers=${tomlTable(s.headers)}`);
    } else {
      skipped.push(s.name);
    }
  }
  return { args, skipped };
}

/** System-prompt section listing the MCP servers the agent has been connected to. */
export function buildMcpServersPrompt(servers: Pick<McpServerConfig, "name" | "description" | "transport">[]): string {
  if (servers.length === 0) return "";
  const lines = servers.map((s) => `- **${s.name}**${s.description ? ` — ${s.description}` : ""}`);
  return [
    "## MCP Servers",
    "The following MCP (Model Context Protocol) servers are connected to this session. Their tools are available to you alongside your built-in tools (in Claude Code they appear as `mcp__<server>__<tool>`). Use them when they help with the task; never print any credentials they expose.",
    ...lines,
  ].join("\n");
}

/** Provider types whose agent we can hand MCP servers to. */
export function providerSupportsMcp(providerType: string): providerType is "cli" | "codex-cli" {
  return providerType === "cli" || providerType === "codex-cli";
}
