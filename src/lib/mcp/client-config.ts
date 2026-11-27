// Copy-pasteable setup snippets for popular MCP clients. Pure and browser-safe — used
// by Settings → MCP (filled in with a freshly created token) and by the /docs/mcp page
// (with a placeholder token). `mcpOAuthClientSnippets()` is the token-less variant for
// clients that sign in through OAuth (src/lib/mcp/oauth.ts).

export const MCP_SERVER_KEY = "task-manager";
export const MCP_TOKEN_PLACEHOLDER = "tm_mcp_YOUR_TOKEN";

export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/mcp`;
}

/** Env var the Codex snippets read a pasted token from. */
export const CODEX_TOKEN_ENV = "TASK_MANAGER_MCP_TOKEN";

export interface McpClientSnippet {
  id: string;
  label: string;
  /** Where the snippet goes, e.g. a file path or "Terminal". */
  where: string;
  code: string;
}

export function mcpClientSnippets(origin: string, token: string = MCP_TOKEN_PLACEHOLDER): McpClientSnippet[] {
  const url = mcpEndpoint(origin);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      where: "Terminal",
      code: `claude mcp add --transport http ${MCP_SERVER_KEY} ${url} \\\n  --header "Authorization: Bearer ${token}"`,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      where: "claude_desktop_config.json (Settings → Developer → Edit Config)",
      code: JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_KEY]: {
              command: "npx",
              args: ["-y", "mcp-remote", url, "--header", "Authorization:${MCP_AUTH}"],
              env: { MCP_AUTH: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: "cursor",
      label: "Cursor",
      where: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
      code: JSON.stringify(
        { mcpServers: { [MCP_SERVER_KEY]: { url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      ),
    },
    {
      id: "vscode",
      label: "VS Code",
      where: ".vscode/mcp.json — prompts for the token so it isn't committed",
      code: JSON.stringify(
        {
          servers: {
            [MCP_SERVER_KEY]: {
              type: "http",
              url,
              headers: { Authorization: "Bearer ${input:taskManagerToken}" },
            },
          },
          inputs: [
            { type: "promptString", id: "taskManagerToken", description: "AI Task Manager MCP token", password: true },
          ],
        },
        null,
        2,
      ),
    },
    {
      id: "codex",
      label: "Codex",
      where: "Terminal — Codex reads the token from an env var, so it never lands in config.toml",
      code:
        `export ${CODEX_TOKEN_ENV}=${token}\n` +
        `codex mcp add ${MCP_SERVER_KEY} --url ${url} --bearer-token-env-var ${CODEX_TOKEN_ENV}`,
    },
    {
      id: "curl",
      label: "cURL (test)",
      where: "Terminal — lists the tools your token can use",
      code:
        `curl -s ${url} \\\n` +
        `  -H "Authorization: Bearer ${token}" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -H "Accept: application/json, text/event-stream" \\\n` +
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
  ];
}

/**
 * Setup for clients that sign in with OAuth: only the URL is configured, and the client
 * opens a browser to the consent page the first time it connects.
 */
export function mcpOAuthClientSnippets(origin: string): McpClientSnippet[] {
  const url = mcpEndpoint(origin);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      where: "Terminal — then run /mcp in Claude Code, pick task-manager and choose Authenticate",
      code: `claude mcp add --transport http ${MCP_SERVER_KEY} ${url}`,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      where: "Settings → Connectors → Add custom connector (the server must be reachable over public HTTPS)",
      code: `Name: Task Manager\nRemote MCP server URL: ${url}`,
    },
    {
      id: "claude-desktop-local",
      label: "Claude Desktop (local server)",
      where: "claude_desktop_config.json — for servers on localhost/your LAN; mcp-remote opens the sign-in page",
      code: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2),
    },
    {
      id: "codex",
      label: "Codex",
      where: "Terminal — `codex mcp add` offers to sign in; otherwise run the login command",
      code: `codex mcp add ${MCP_SERVER_KEY} --url ${url}\ncodex mcp login ${MCP_SERVER_KEY}`,
    },
    {
      id: "vscode",
      label: "VS Code",
      where: ".vscode/mcp.json — VS Code prompts you to sign in when the server starts",
      code: JSON.stringify({ servers: { [MCP_SERVER_KEY]: { type: "http", url } } }, null, 2),
    },
    {
      id: "cursor",
      label: "Cursor",
      where: "~/.cursor/mcp.json — Cursor shows a Login button for the server",
      code: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { url } } }, null, 2),
    },
  ];
}
