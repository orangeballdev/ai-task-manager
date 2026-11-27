// The structure of /settings: every settings page, grouped into the sections
// the sidebar shows. Pure data (no React) so the search index and its test can
// check against it. Add a page here when adding a new /settings/* route.

export interface SettingsPage {
  /** Route, e.g. "/settings/general". */
  href: string;
  /** Sidebar label and page heading. */
  label: string;
  /** One-line summary shown under the page heading. */
  description: string;
}

export interface SettingsGroup {
  label: string;
  pages: SettingsPage[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Workspace",
    pages: [
      {
        href: "/settings/general",
        label: "General",
        description: "Task execution limits, navigation, the assistant, appearance and the server address.",
      },
      {
        href: "/settings/notifications",
        label: "Notifications",
        description: "How email is sent (SMTP or Amazon SES) and which alerts you get.",
      },
      {
        href: "/settings/data",
        label: "Data",
        description: "Backup & restore, automatic cleanup, file retention and bulk deletion.",
      },
    ],
  },
  {
    label: "Agents",
    pages: [
      {
        href: "/settings/ai",
        label: "AI Providers",
        description: "Provider connections, smart picking and auto-switch, effort, health checks and agent instructions.",
      },
      {
        href: "/settings/git",
        label: "Git",
        description: "Git provider, access token, SSH key, repository defaults and committer identity.",
      },
      {
        href: "/settings/tools",
        label: "Agent Tools",
        description: "External CLIs (like the GitHub CLI) agents may use, and their credentials.",
      },
      {
        href: "/settings/mcp-servers",
        label: "MCP Servers",
        description: "MCP servers attached to every agent run.",
      },
    ],
  },
  {
    label: "Connections",
    pages: [
      {
        href: "/settings/integrations",
        label: "Integrations",
        description: "Create and manage tasks from Slack or by email.",
      },
      {
        href: "/settings/api",
        label: "API",
        description: "API keys for the REST API and the OpenAI/Anthropic-compatible gateway.",
      },
      {
        href: "/settings/mcp",
        label: "MCP Access",
        description: "Tokens and OAuth grants that let assistants drive this Task Manager over MCP.",
      },
      {
        href: "/settings/observability",
        label: "Observability",
        description: "OpenTelemetry export of traces, metrics and logs, and opt-in ObiStack user monitoring.",
      },
    ],
  },
  {
    label: "Account",
    pages: [
      {
        href: "/settings/account",
        label: "Account",
        description: "Your password, passkeys and active sessions.",
      },
      {
        href: "/settings/security",
        label: "Security",
        description: "Sign-in requirement, sign-ups, accounts and the sign-in log.",
      },
    ],
  },
];

export const SETTINGS_PAGES: SettingsPage[] = SETTINGS_GROUPS.flatMap((g) => g.pages);

/** The page a pathname belongs to (exact match or a nested route under it). */
export function findSettingsPage(pathname: string): SettingsPage | undefined {
  return SETTINGS_PAGES.find(
    (p) => pathname === p.href || pathname.startsWith(`${p.href}/`),
  );
}
