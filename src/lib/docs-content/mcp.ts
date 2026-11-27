// Content of the /docs/mcp page, shared with the MCP get_docs tool. The tools and prompts
// reference is generated from the live definitions, which are passed in (rather than imported)
// because src/lib/mcp/tools.ts imports this module for get_docs.
import { mcpClientSnippets, mcpEndpoint, mcpOAuthClientSnippets } from "@/lib/mcp/client-config";
import type { McpPromptDefinition, McpToolDefinition, ToolInputSchema } from "@/lib/mcp/protocol";
import { absoluteLinks, mdCode, mdDoc, mdList, mdTable } from "./markdown";

export interface McpDocParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface SchemaProp {
  type?: string | string[];
  enum?: unknown[];
  items?: { type?: string; enum?: unknown[] };
  description?: string;
}

function schemaType(p: SchemaProp): string {
  if (p.enum) return p.enum.filter((v) => v !== "").map((v) => JSON.stringify(v)).join(" | ");
  if (p.type === "array") {
    if (p.items?.enum) return `(${p.items.enum.map((v) => JSON.stringify(v)).join(" | ")})[]`;
    return `${p.items?.type ?? "item"}[]`;
  }
  if (Array.isArray(p.type)) return p.type.join(" | ");
  return p.type ?? "any";
}

/** A tool's input schema as a flat parameter list (for the docs tables). */
export function schemaParams(schema: ToolInputSchema): McpDocParam[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, raw]) => {
    const p = raw as SchemaProp;
    return { name, type: schemaType(p), required: required.has(name), description: p.description ?? "" };
  });
}

export const MCP_USE_CASES: { id: string; title: string; intro: string; prompts: string[] }[] = [
  {
    id: "ask",
    title: "Ask questions about tasks",
    intro:
      "Read-only tokens are enough. The assistant searches with list_tasks, drills in with get_task / get_task_logs, and totals things up with get_task_stats.",
    prompts: [
      "What's currently running, and what's waiting for my review?",
      "Why did the task about the Stripe webhook fail? Show me the error.",
      "Which tasks touched the acme/web repo this week, and what did each one change?",
      "How much did tasks cost in the last 30 days, broken down by status?",
      "Summarise the PR and test plan for task cmw123… in three bullet points.",
      "Find every task labelled \"security\" that hasn't been reviewed yet.",
      "Read the report that task cmw456… produced and give me the key findings.",
    ],
  },
  {
    id: "create",
    title: "Create tasks",
    intro:
      "Needs a Read & write token. Repo defaults from the Repositories page (branch, PR vs. branch, priority, labels…) apply to anything you don't specify.",
    prompts: [
      "Create a task on https://github.com/acme/web.git to add rate limiting to the /login endpoint, and open a PR when it's done.",
      "Create a high-priority task to upgrade Next.js in acme/web, but leave it in the backlog — I'll start it later.",
      "Break \"migrate the billing service from REST to gRPC\" into 4–5 tasks that run one after another, and show me the plan before creating them.",
      "Schedule a task for tomorrow 9am UTC to regenerate the API client in acme/sdk.",
      "Look at the TODO comments in this file and create one task per TODO against our repo.",
    ],
  },
  {
    id: "edit",
    title: "Edit and steer tasks",
    intro:
      "update_task changes fields of a queued or finished task; send_task_message steers one that's running (or re-runs a finished one with new instructions).",
    prompts: [
      "Bump the priority of the dark-mode task to urgent and add the label \"ux\".",
      "Rewrite the description of task cmw789… so it also covers the mobile layout.",
      "Tell the running migration task to skip the legacy tables.",
      "Move every pending task labelled \"experiment\" to the backlog.",
      "Cancel the task that's refactoring the auth module — I've changed my mind.",
      "Re-run all tasks that failed yesterday with a rate-limit error.",
    ],
  },
  {
    id: "review",
    title: "Review tasks",
    intro:
      "The assistant reads the task's description, logs, PR summary, test plan and CI state, then you decide. 'Approve' moves it to Done; 'request changes' re-runs the agent on the same branch with your feedback.",
    prompts: [
      "Review everything in In Review, oldest first, and tell me which look safe to approve.",
      "Review task cmw123… — did it fully do what was asked? Check the logs for skipped tests.",
      "Approve task cmw123… with the note \"merged manually\".",
      "Request changes on task cmw123…: add unit tests for the new validator and handle empty input.",
    ],
  },
  {
    id: "review-only",
    title: "Review work done elsewhere",
    intro:
      "create_task with reviewOnly: true makes a review-only ticket: a reminder to review work that was already done " +
      "somewhere else, such as a commit pushed by hand or from another Claude session. It goes straight to In Review, " +
      "never runs an agent and spends no tokens. The description says what to review and why (e.g. the commit message); " +
      "reviewMetadata holds the repo (a saved repo or any Git URL), branch, commit SHAs (7–40 hex chars, stored as given) " +
      "and an optional PR link, all optional and editable later with update_task. list_tasks finds it by commit SHA or PR URL. " +
      "review_task approve moves it to Done; request_changes is refused because there's no agent run to continue, so " +
      "create a normal task on the referenced branch instead.",
    prompts: [
      "I just pushed 65948886 to develop on git@github.com:acme/web.git — create an In Review ticket so I remember to review it, using the commit message as the description.",
      "Add commit a1b2c3d4 and PR https://github.com/acme/web/pull/42 to review ticket cmw123….",
      "Which task is about commit 65948886?",
      "Approve the review ticket for the executive summary change.",
    ],
  },
  {
    id: "docs",
    title: "Ask about the Task Manager itself",
    intro:
      "Any token works. The assistant reads these docs with get_docs, so it can answer setup questions and write integration code against this deployment.",
    prompts: [
      "How do I point my LangChain app at the Task Manager's OpenAI-compatible endpoint?",
      "Write a Python script that creates a task through the REST API and waits for it to finish.",
      "Which of my providers can do tool calling through the OpenAI-compatible API?",
    ],
  },
];

export const MCP_DOC = {
  title: "MCP Server",
  intro:
    "The Task Manager speaks the [Model Context Protocol](https://modelcontextprotocol.io), so AI assistants like " +
    "Claude Code, Claude Desktop, Cursor and VS Code can work with your tasks directly: ask questions about them, " +
    "create and edit them, start or cancel runs, steer running agents, and review the results — all from a chat.",
  transport: "Streamable HTTP, stateless, JSON responses.",
  auth:
    "OAuth 2.1 sign-in (authorization code + PKCE, dynamic client registration), or `Authorization: Bearer tm_mcp_…` " +
    "with a token from [Settings → MCP](/settings/mcp).",

  oauthIntro:
    "Clients that support MCP's OAuth sign-in — Claude Code, Claude Desktop, Codex, VS Code, Cursor and others — need " +
    "nothing but the server URL. The first time they connect, the server answers `401` and points them at its OAuth " +
    "metadata; the client registers itself, opens your browser on a consent page here, and you choose **Approve** with " +
    "Read only or Read & write access. No token to copy, and the client refreshes its access on its own.",
  oauthNotes: [
    "**Claude Code**: after `claude mcp add`, run `/mcp`, select `task-manager` and choose **Authenticate**. The browser " +
      "opens on this app's consent page.",
    "**Claude Desktop custom connectors** are connected from Anthropic's cloud, so the Task Manager must be reachable " +
      "over public HTTPS. For a server on localhost or your LAN, use the `mcp-remote` config instead — it runs the sign-in " +
      "on your machine.",
    "**Codex**: `codex mcp add` with a URL offers to sign in straight away; `codex mcp login task-manager` (re)does it " +
      "any time. Older Codex versions need `experimental_use_rmcp_client = true` in `~/.codex/config.toml` for HTTP servers.",
    "Each approved client shows up in [Settings → MCP](/settings/mcp) with an **OAuth** badge. Change its access or " +
      "disconnect it there, like any token. Access tokens last an hour and are refreshed automatically; a client that " +
      "hasn't connected for 30 days has to sign in again.",
    "The consent page has no login of its own — like the rest of the app, anyone who can open it can approve. Keep the " +
      "app on a trusted network or behind your own authentication proxy.",
  ],
  oauthEndpoints: [
    ["Protected resource metadata", "`/.well-known/oauth-protected-resource/api/mcp` (RFC 9728)"],
    ["Authorization server metadata", "`/.well-known/oauth-authorization-server` (RFC 8414)"],
    ["Client registration", "`POST /api/oauth/register` (RFC 7591)"],
    ["Authorization", "`/oauth/authorize` (code flow, PKCE `S256` required)"],
    ["Token", "`POST /api/oauth/token` (`authorization_code`, `refresh_token`)"],
    ["Revocation", "`POST /api/oauth/revoke` (RFC 7009)"],
    ["Scopes", "`mcp:read`, `mcp:write` — the consent page has the final say"],
  ],
  tokenSectionIntro:
    "For clients without OAuth support, scripts, or when you'd rather manage credentials yourself.",

  tokenIntro:
    "Go to [Settings → MCP](/settings/mcp), name the token after the client that will use it (e.g. \"Claude Code – " +
    "laptop\") and choose its access:",
  tokenAccess: [
    ["Read only", "Only the read tools are visible: search and inspect tasks, logs, output files, repos, teams, stats and these docs. Perfect for asking questions — it can't change anything."],
    ["Read & write", "Adds the tools that create, edit, start, cancel, message and review tasks."],
  ],
  tokenNote:
    "The token is shown once — copy it straight away. You can change a token's access or revoke it at any time; the " +
    "change applies to the client's next request. MCP tokens and REST API keys are separate: one never works in place " +
    "of the other.",

  connectIntro:
    "Replace `tm_mcp_YOUR_TOKEN` with your token. The URL below already points at this deployment. (Creating a token " +
    "in Settings shows these snippets with the token filled in.)",
  connectNotes: [
    "**Claude Code**: add `--scope user` to make the server available in every project, or `--scope project` to share " +
      "it via `.mcp.json` (don't commit the token — use an env var such as `${TASK_MANAGER_TOKEN}` in the header instead).",
    "**Claude Desktop**: uses the `mcp-remote` bridge (needs Node.js). Restart Claude Desktop after editing the config.",
    "Your client must be able to reach this server. If the Task Manager runs on a private network or localhost, run " +
      "the client on the same machine/network (or behind your VPN).",
  ],

  checkIntro:
    "In Claude Code run `/mcp` — the `task-manager` server should show as connected with its tools. Then just ask:",
  checkExample: "> What tasks are waiting for my review?",
  checkOutro:
    "The token's \"Last used\" time in Settings → MCP updates on every request, which is a quick way to confirm the " +
    "client is really talking to the server.",

  examplesIntro: "You talk to your assistant in plain language; it picks the tools. Some things to try:",
  promptsIntro:
    "The server also ships ready-made workflows. In Claude Code they appear as slash commands, e.g. " +
    "`/mcp__task-manager__review_task cmw123…`; other clients list them in their prompt/attachment menu.",
  toolsIntro: (reads: number, writes: number) =>
    `${reads} read tools available to every token, plus ${writes} write tools for Read & write tokens. Read-only ` +
    "tokens don't see write tools at all. Deleting tasks and changing settings are deliberately not exposed.",

  security: [
    "Only a SHA-256 hash of each token is stored; the token itself is shown once, at creation.",
    "Use one token per client/device so you can revoke one without disconnecting the rest.",
    "Prefer **Read only** unless you want the assistant to change tasks. Write tools that cancel or re-run work are " +
      "marked destructive, so well-behaved clients ask before calling them.",
    "Anything an agent run can do, a write token can trigger — tasks run with the Git, provider and tool access " +
      "configured in Settings. Treat write tokens like a password.",
    "Serve the app over HTTPS when clients connect across a network, since the token travels in a header.",
    "OAuth clients get short-lived (1 hour) access tokens plus a rotating refresh token; only hashes of both are " +
      "stored. Approving is the only way an OAuth client gets access — registering one grants nothing on its own.",
  ],

  troubleshooting: [
    ["401 / “Invalid or revoked MCP token”", "Check the token was copied in full and hasn't been revoked. The header must be exactly `Authorization: Bearer tm_mcp_…`"],
    ["OAuth sign-in doesn't start", "Make sure no `Authorization` header is configured for the server — a client with a header never tries OAuth. Also check the client can fetch `/.well-known/oauth-protected-resource/api/mcp`; a reverse proxy must forward `/.well-known/*` and the `Host`/`X-Forwarded-Proto` headers."],
    ["Consent page says “Unknown client_id”", "The client registered against a different server (or the database was reset). Remove the server from the client and add it again so it re-registers."],
    ["OAuth client keeps asking to sign in again", "It was disconnected in Settings → MCP, or hadn't connected for 30 days. Approve a new sign-in."],
    ["“That's a REST API key”", "`tm_live_…` keys are for the REST API. Create an MCP token under Settings → MCP."],
    ["Write tools missing / “token is read-only”", "Switch the token to Read & write in Settings → MCP, then reconnect the client so it re-fetches the tool list."],
    ["Client can't connect at all", "Run the cURL snippet from the same machine as the client. If that fails, the client can't reach the server (firewall, VPN, localhost)."],
    ["Tasks are created but never run", "The worker process must be running alongside the app (`npm run worker`). Created tasks wait as pending until it picks them up."],
    ["Claude Desktop shows the server as failed", "Make sure Node.js/npx is installed and on PATH, then fully restart Claude Desktop. Its MCP logs are under Settings → Developer."],
  ],
};

export interface McpDocsDefinitions {
  // Only the documentation fields are read, so any context type will do.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: McpToolDefinition<any>[];
  prompts: McpPromptDefinition[];
}

/** Markdown heading text of a tool's block in the tools reference. */
function mcpToolHeading(t: Pick<McpToolDefinition<unknown>, "name" | "title" | "access">): string {
  return `\`${t.name}\` — ${t.title} (${t.access})`;
}

/**
 * Anchors for the sub-sections of /docs/mcp that have their own id on the page (each use case
 * and each tool), keyed by heading markdown, so docs search can jump straight to them.
 * Keep in sync with the ids in src/app/docs/mcp/page.tsx.
 */
export function mcpSubAnchors(defs: McpDocsDefinitions): Record<string, string> {
  return {
    "Read tools": "tools-read",
    "Write tools": "tools-write",
    ...Object.fromEntries(MCP_USE_CASES.map((uc) => [uc.title, `examples-${uc.id}`])),
    ...Object.fromEntries(defs.tools.map((t) => [mcpToolHeading(t), `tool-${t.name}`])),
  };
}

export function mcpDocsMarkdown(origin: string, defs: McpDocsDefinitions): string {
  const d = MCP_DOC;
  const reads = defs.tools.filter((t) => t.access === "read");
  const writes = defs.tools.filter((t) => t.access === "write");
  const toolBlock = (t: McpToolDefinition<unknown>) => {
    const params = schemaParams(t.inputSchema);
    return mdDoc(
      `#### ${mcpToolHeading(t)}`,
      t.description,
      params.length > 0 && mdTable(
        ["Argument", "Type", "Required", "Description"],
        params.map((p) => [`\`${p.name}\``, p.type, p.required ? "yes" : "", p.description]),
      ),
    );
  };

  return absoluteLinks(
    mdDoc(
      `# ${d.title}`,
      d.intro,
      mdList([`Endpoint: \`${mcpEndpoint(origin)}\``, `Transport: ${d.transport}`, `Auth: ${d.auth}`]),
      "## Setup",
      `### Option 1: Sign in with OAuth (recommended)\n\n${d.oauthIntro}`,
      ...mcpOAuthClientSnippets(origin).map((s) => `**${s.label}** (${s.where})\n\n${mdCode(s.code)}`),
      mdList(d.oauthNotes),
      mdTable(["OAuth endpoint", "Path"], d.oauthEndpoints),
      `### Option 2: Use an access token\n\n${d.tokenSectionIntro}`,
      `#### Create an access token\n\n${d.tokenIntro}`,
      mdTable(["Access", "What it allows"], d.tokenAccess),
      d.tokenNote,
      `#### Connect your client\n\n${d.connectIntro}`,
      ...mcpClientSnippets(origin).map((s) => `**${s.label}** (${s.where})\n\n${mdCode(s.code)}`),
      mdList(d.connectNotes),
      `### Check it works\n\n${d.checkIntro}`,
      mdCode(d.checkExample),
      d.checkOutro,
      "## Examples",
      d.examplesIntro,
      ...MCP_USE_CASES.map((uc) => mdDoc(`### ${uc.title}`, uc.intro, mdList(uc.prompts.map((p) => `“${p}”`)))),
      "## Built-in prompts",
      d.promptsIntro,
      mdTable(
        ["Prompt", "Access", "Description", "Arguments"],
        defs.prompts.map((p) => [
          `\`${p.name}\``,
          p.access ?? "read",
          p.description ?? "",
          (p.arguments ?? []).map((a) => `${a.name}${a.required ? "" : " (optional)"}`).join(", "),
        ]),
      ),
      "## Tools reference",
      d.toolsIntro(reads.length, writes.length),
      "### Read tools",
      ...reads.map(toolBlock),
      "### Write tools",
      ...writes.map(toolBlock),
      "## Security",
      mdList(d.security),
      "## Troubleshooting",
      mdTable(["Problem", "Fix"], d.troubleshooting),
    ),
    origin,
  );
}
