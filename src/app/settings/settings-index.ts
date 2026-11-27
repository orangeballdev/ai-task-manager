// Static, searchable index of every setting exposed under /settings.
//
// Each entry maps a human-facing setting to the sub-page it lives on plus an
// optional anchor id (matching an `id` on the setting's CardTitle) so search
// results can deep-link and scroll straight to it. Keep this in sync when
// adding or removing settings on the pages below.

export interface SettingsIndexEntry {
  /** The setting's display title (matches the card heading on the page). */
  title: string;
  /** The settings sub-page href, e.g. "/settings/general". */
  href: string;
  /** Human-readable section label for grouping/badges. */
  section: string;
  /** Optional element id on the page to scroll to (CardTitle id). */
  anchor?: string;
  /** Short description shown under the title in results. */
  description: string;
  /** Extra search terms/synonyms that aren't in the title or description. */
  keywords?: string[];
}

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  // ---- General ----
  {
    title: "Task Timeout",
    href: "/settings/general",
    section: "General",
    anchor: "task-timeout",
    description: "Maximum time a task may run before it is killed and marked failed.",
    keywords: ["timeout", "kill", "minutes", "run time", "hang", "stuck"],
  },
  {
    title: "Number Of Concurrent Tasks",
    href: "/settings/general",
    section: "General",
    anchor: "concurrent-tasks",
    description: "How many tasks the worker can run at the same time.",
    keywords: ["concurrent", "parallel", "simultaneous", "workers"],
  },
  {
    title: "Task Throttling",
    href: "/settings/general",
    section: "General",
    anchor: "task-throttling",
    description: "Limit how many tasks the worker starts per hour.",
    keywords: ["throttle", "rate limit", "per hour", "cap"],
  },
  {
    title: "Auto-Retry on Failure",
    href: "/settings/general",
    section: "General",
    anchor: "auto-retry",
    description: "Automatically retry tasks that fail from transient errors.",
    keywords: ["retry", "failure", "transient", "auto retry"],
  },
  {
    title: "Hail Mary Burst Mode",
    href: "/settings/general",
    section: "General",
    anchor: "hail-mary",
    description: "Burst extra recurring runs to use unused quota before it resets.",
    keywords: ["hail mary", "burst", "quota", "usage window"],
  },
  {
    title: "Home Page",
    href: "/settings/general",
    section: "General",
    anchor: "home-page",
    description: "The page shown when you load the app and where the logo links.",
    keywords: ["home", "landing", "default page", "start page"],
  },
  {
    title: "Task Board",
    href: "/settings/general",
    section: "General",
    anchor: "task-board",
    description: "Show or hide the Task Board (kanban) view in the navigation.",
    keywords: ["board", "kanban", "nav", "navigation"],
  },
  {
    title: "Repositories",
    href: "/settings/general",
    section: "General",
    anchor: "repositories",
    description: "Save Git repos and set a default context applied to their tasks.",
    keywords: ["repository", "repo", "git", "default context", "knowledge"],
  },
  {
    title: "Auto-Enhance Task Descriptions",
    href: "/settings/general",
    section: "General",
    anchor: "auto-enhance-description",
    description: "Automatically enhance your task description on submit.",
    keywords: ["enhance", "description", "improve", "rewrite"],
  },
  {
    title: "Chat Assistant Level",
    href: "/settings/general",
    section: "General",
    anchor: "chat-assistant-level",
    description: "How much the chat assistant asks before proposing a task.",
    keywords: ["chat", "assistant", "chatbot", "questions"],
  },

  // ---- Layout ----
  {
    title: "Card arrangement",
    href: "/settings/layout",
    section: "Layout",
    anchor: "card-arrangement",
    description: "Reorder the cards shown on task and dashboard views.",
    keywords: ["layout", "arrange", "order", "cards", "reorder"],
  },
  {
    title: "Card density",
    href: "/settings/layout",
    section: "Layout",
    anchor: "card-density",
    description: "Choose a compact or comfortable spacing for cards.",
    keywords: ["density", "compact", "spacing", "comfortable"],
  },
  {
    title: "Files view",
    href: "/settings/layout",
    section: "Layout",
    anchor: "files-view",
    description: "Configure how changed files are displayed.",
    keywords: ["files", "view", "diff", "changes"],
  },

  // ---- AI ----
  {
    title: "Auto-Switch Provider",
    href: "/settings/ai",
    section: "AI",
    anchor: "auto-switch-provider",
    description: "Fall back to another provider when one is rate-limited.",
    keywords: ["provider", "fallback", "switch", "rate limit"],
  },
  {
    title: "Smart Provider Picker",
    href: "/settings/ai",
    section: "AI",
    anchor: "smart-provider-picker",
    description: "Automatically choose the best available provider at run time.",
    keywords: ["smart", "provider", "picker", "auto"],
  },
  {
    title: "Health Checks",
    href: "/settings/ai",
    section: "AI",
    anchor: "health-checks",
    description: "Periodically verify provider credentials and availability.",
    keywords: ["health", "checks", "credentials", "status"],
  },
  {
    title: "Max Output Tokens (CLI)",
    href: "/settings/ai",
    section: "AI",
    anchor: "max-output-tokens",
    description: "Cap the maximum output tokens for CLI provider runs.",
    keywords: ["tokens", "output", "max tokens", "cli", "limit"],
  },
  {
    title: "Agent Delegation",
    href: "/settings/ai",
    section: "AI",
    anchor: "agent-delegation",
    description: "Let the agent delegate to subagents and pick the best model per agent.",
    keywords: ["agent", "delegation", "subagent", "subagents", "model", "opus", "sonnet", "haiku", "task tool", "per agent model"],
  },
  {
    title: "Global Agent Instructions",
    href: "/settings/ai",
    section: "AI",
    anchor: "global-agent-instructions",
    description: "Instructions injected into every task's prompt.",
    keywords: ["instructions", "agent", "system prompt", "global"],
  },
  {
    title: "Prompt Builder & Chat Assistant",
    href: "/settings/ai",
    section: "AI",
    anchor: "prompt-builder",
    description: "Configure how prompts and the chat assistant are built.",
    keywords: ["prompt", "builder", "chat", "assistant"],
  },
  {
    title: "AI Providers",
    href: "/settings/ai",
    section: "AI",
    anchor: "ai-providers",
    description: "Manage API keys, models, and configured AI providers.",
    keywords: ["providers", "api key", "model", "anthropic", "openai"],
  },
  {
    title: "Default Effort",
    href: "/settings/ai",
    section: "AI",
    anchor: "default-effort",
    description: "Thinking effort level new tasks are pre-filled with.",
    keywords: ["effort", "thinking", "reasoning", "default", "low", "medium", "high", "xhigh", "max"],
  },

  // ---- Git ----
  {
    title: "Git Provider",
    href: "/settings/git",
    section: "Git",
    anchor: "git-provider",
    description: "Choose GitHub, GitLab, or another Git hosting provider.",
    keywords: ["git", "github", "gitlab", "provider"],
  },
  {
    title: "Personal Access Token",
    href: "/settings/git",
    section: "Git",
    anchor: "personal-access-token",
    description: "Token used to clone and push to your repositories.",
    keywords: ["token", "pat", "access token", "auth"],
  },
  {
    title: "Pull Request Status Sync",
    href: "/settings/git",
    section: "Git",
    anchor: "pr-status-sync",
    description: "Keep pull request status in sync with tasks.",
    keywords: ["pull request", "pr", "sync", "status"],
  },
  {
    title: "Repository Defaults",
    href: "/settings/git",
    section: "Git",
    anchor: "auto-apply-previous-run-settings",
    description: "Auto-apply previous run settings (branch, after task completes) for known repos.",
    keywords: ["auto apply", "previous run", "use previous run settings", "default branch", "history", "repo defaults"],
  },
  {
    title: "Committer Identity",
    href: "/settings/git",
    section: "Git",
    anchor: "committer-identity",
    description: "Name and email used for commits the worker makes.",
    keywords: ["committer", "identity", "name", "email", "author"],
  },
  {
    title: "SSH Private Key",
    href: "/settings/git",
    section: "Git",
    anchor: "ssh-private-key",
    description: "SSH key used for Git operations over SSH.",
    keywords: ["ssh", "private key", "key", "auth"],
  },

  // ---- Agent Tools ----
  {
    title: "GitHub CLI",
    href: "/settings/tools",
    section: "Agent Tools",
    anchor: "github-cli",
    description: "Let agents use the gh CLI (create issues, comment on PRs), set its token and whether tasks get it by default.",
    keywords: ["gh", "github", "cli", "issue", "token", "tool access", "permissions", "agent tools", "default access"],
  },

  // ---- Notifications ----
  {
    title: "Email Delivery (SMTP / Amazon SES)",
    href: "/settings/notifications",
    section: "Notifications",
    anchor: "email-delivery",
    description: "Choose how emails are sent (SMTP server or Amazon SES) and the sender address.",
    keywords: ["email", "smtp", "ses", "aws", "sender", "from address", "mail server", "gmail", "app password"],
  },
  {
    title: "Email Notifications",
    href: "/settings/notifications",
    section: "Notifications",
    anchor: "email-notifications",
    description: "Send email when tasks complete or fail.",
    keywords: ["email", "notifications", "alerts"],
  },

  // ---- Integrations ----
  {
    title: "Slack Bot",
    href: "/settings/integrations",
    section: "Integrations",
    anchor: "slack-bot",
    description: "Create and manage tasks from Slack.",
    keywords: ["slack", "bot", "integration", "chat"],
  },

  // ---- Observability ----
  {
    title: "User Monitoring (ObiStack)",
    href: "/settings/observability",
    section: "Observability",
    anchor: "user-monitoring",
    description: "Opt in to sending page views, clicks, web vitals and front-end errors from the UI to ObiStack.",
    keywords: ["obistack", "user monitoring", "analytics", "web analytics", "rum", "page views", "web vitals", "lsk"],
  },
  {
    title: "OpenTelemetry Export",
    href: "/settings/observability",
    section: "Observability",
    anchor: "otel-export",
    description: "Turn exporting traces, metrics and logs via OpenTelemetry on or off.",
    keywords: ["otel", "opentelemetry", "telemetry", "observability", "tracing", "monitoring"],
  },
  {
    title: "Telemetry Destinations",
    href: "/settings/observability",
    section: "Observability",
    anchor: "otel-destinations",
    description: "One or more OTLP collectors or backends to export to, each with its own endpoint, protocol, headers and signals.",
    keywords: ["otlp", "endpoint", "grpc", "http", "headers", "api key", "collector", "destination", "multiple", "dual", "fan out", "grafana", "honeycomb", "datadog", "jaeger", "test"],
  },
  {
    title: "Telemetry Service",
    href: "/settings/observability",
    section: "Observability",
    anchor: "otel-service",
    description: "Service name and resource attributes reported to every destination.",
    keywords: ["service name", "service.namespace", "resource attributes", "environment"],
  },
  {
    title: "Telemetry Signals",
    href: "/settings/observability",
    section: "Observability",
    anchor: "otel-signals",
    description: "Choose which of traces, metrics and logs are exported.",
    keywords: ["traces", "spans", "metrics", "logs", "console", "interval", "database", "db", "prisma", "sql", "query", "slow query"],
  },
  {
    title: "Claude Code Telemetry",
    href: "/settings/observability",
    section: "Observability",
    anchor: "otel-agent",
    description: "Forward a destination's settings to the Claude CLI so it exports its own telemetry.",
    keywords: ["claude code", "cli", "agent", "forward", "CLAUDE_CODE_ENABLE_TELEMETRY"],
  },
  // ---- API ----
  {
    title: "API Keys",
    href: "/settings/api",
    section: "API",
    anchor: "api-keys",
    description: "Create and revoke keys used to authenticate against the public API.",
    keywords: ["api", "key", "token", "public api", "bearer", "authentication", "docs"],
  },
  {
    title: "Disable API Proxy Temporarily",
    href: "/settings/api",
    section: "API",
    anchor: "llm-gateway",
    description: "Pause the OpenAI / Anthropic-compatible endpoint for a while so it stops spending tokens.",
    keywords: ["gateway", "proxy", "llm", "disable", "pause", "turn off", "openai", "anthropic", "tokens"],
  },
  // ---- MCP Servers ----
  {
    title: "MCP Servers",
    href: "/settings/mcp-servers",
    section: "MCP Servers",
    anchor: "mcp-servers",
    description: "Connect external MCP servers (stdio commands or remote HTTP/SSE) whose tools agents can use while running tasks.",
    keywords: ["mcp", "model context protocol", "server", "connection", "connector", "agent", "tools", "stdio", "http", "sse", "integration"],
  },
  // ---- MCP ----
  {
    title: "MCP Access Tokens",
    href: "/settings/mcp",
    section: "MCP",
    anchor: "mcp-tokens",
    description: "Create read-only or read & write tokens that let MCP clients (Claude Code, Claude Desktop, Cursor) work with tasks.",
    keywords: ["mcp", "model context protocol", "token", "claude code", "claude desktop", "cursor", "vs code", "assistant", "connector", "read only", "write", "access"],
  },

  // ---- Data ----
  {
    title: "Backup & Restore",
    href: "/settings/data",
    section: "Data",
    anchor: "backup-restore",
    description: "Download a database backup or restore from a backup file.",
    keywords: ["backup", "restore", "export", "import", "dump", "database", "download", "upload", "snapshot"],
  },
  {
    title: "Automatic Cleanup",
    href: "/settings/data",
    section: "Data",
    anchor: "automatic-cleanup",
    description: "Automatically remove old tasks and workspaces — all finished tasks or Done tasks only.",
    keywords: ["cleanup", "auto", "prune", "workspaces", "retention", "done"],
  },
  {
    title: "File Retention",
    href: "/settings/data",
    section: "Data",
    anchor: "file-retention",
    description: "How long generated files are kept before deletion.",
    keywords: ["retention", "files", "keep", "storage"],
  },
  {
    title: "Delete Tasks",
    href: "/settings/data",
    section: "Data",
    anchor: "delete-tasks",
    description: "Bulk delete tasks and their history.",
    keywords: ["delete", "tasks", "remove", "clear"],
  },

  // ---- Account ----
  {
    title: "Change password",
    href: "/settings/account",
    section: "Account",
    anchor: "password",
    description: "Set or change the password for your account.",
    keywords: ["password", "login", "credentials"],
  },
  {
    title: "Passkeys",
    href: "/settings/account",
    section: "Account",
    anchor: "passkeys",
    description: "Register passkeys (Touch ID, Face ID, Windows Hello, security keys) to sign in without a password.",
    keywords: ["passkey", "webauthn", "fido", "yubikey", "touch id", "face id", "2fa", "mfa"],
  },
  {
    title: "Password sign-in",
    href: "/settings/account",
    section: "Account",
    anchor: "password-login",
    description: "Turn off email + password sign-in so only your passkeys work.",
    keywords: ["passkey only", "disable password", "passwordless"],
  },
  {
    title: "Active sessions",
    href: "/settings/account",
    section: "Account",
    anchor: "sessions",
    description: "See where you're signed in and sign other devices out.",
    keywords: ["sessions", "devices", "sign out", "logout"],
  },

  // ---- Security ----
  {
    title: "Require sign-in",
    href: "/settings/security",
    section: "Security",
    anchor: "require-sign-in",
    description: "Turn signing in to the web UI on or off. Off on fresh installs.",
    keywords: ["authentication", "login", "sign in", "password", "auth", "disable login", "public"],
  },
  {
    title: "Sign-ups",
    href: "/settings/security",
    section: "Security",
    anchor: "signups",
    description: "Allow or block creating new accounts at /signup.",
    keywords: ["signup", "register", "registration", "new users", "accounts"],
  },
  {
    title: "Accounts",
    href: "/settings/security",
    section: "Security",
    anchor: "accounts",
    description: "Every account on this instance; delete ones you don't recognise.",
    keywords: ["users", "accounts", "delete user"],
  },
  {
    title: "Sign-in log",
    href: "/settings/security",
    section: "Security",
    anchor: "sign-in-log",
    description: "Audit log of every sign-in attempt, sign-up and sign-out with IP and device.",
    keywords: ["audit", "login history", "sign in log", "failed logins", "security log"],
  },

  // ---- Admin ----
  {
    title: "App Host",
    href: "/settings/admin",
    section: "Admin",
    anchor: "app-host",
    description: "The public host/URL the app is served from.",
    keywords: ["host", "url", "domain", "base url"],
  },
];

/** Case-insensitive fuzzy-ish search over the settings index. */
export function searchSettings(query: string): SettingsIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);

  const scored = SETTINGS_INDEX.map((entry) => {
    const haystack = [
      entry.title,
      entry.section,
      entry.description,
      ...(entry.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();

    // Every term must appear somewhere for the entry to match.
    if (!terms.every((t) => haystack.includes(t))) return null;

    let score = 0;
    const titleLower = entry.title.toLowerCase();
    for (const t of terms) {
      if (titleLower.includes(t)) score += 10;
      if (titleLower.startsWith(t)) score += 5;
      if ((entry.keywords ?? []).some((k) => k.toLowerCase().includes(t))) score += 3;
    }
    return { entry, score };
  }).filter((x): x is { entry: SettingsIndexEntry; score: number } => x !== null);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.entry);
}
