// Static nav for the public docs site (/docs). Modeled on settings-index.ts: one flat
// config that both the sidebar and (eventually) a docs search box can read from, so
// adding a new docs section later is just adding an entry here plus a page under
// src/app/docs/<slug>/page.tsx — no layout changes required.
export interface DocsNavItem {
  title: string;
  href: string;
  /** Optional in-page anchor for sub-navigation within a single long page (e.g. an endpoint). */
  anchor?: string;
}

export interface DocsNavSection {
  title: string;
  items: DocsNavItem[];
}

export const DOCS_NAV: DocsNavSection[] = [
  {
    title: "Getting Started",
    items: [{ title: "Introduction", href: "/docs" }],
  },
  {
    title: "API Reference",
    items: [
      { title: "Overview & Authentication", href: "/docs/api", anchor: "overview" },
      { title: "Create a task", href: "/docs/api", anchor: "create-task" },
      { title: "Start a task", href: "/docs/api", anchor: "start-task" },
      { title: "Get a task", href: "/docs/api", anchor: "get-task" },
      { title: "Update a task", href: "/docs/api", anchor: "update-task" },
      { title: "List tasks", href: "/docs/api", anchor: "list-tasks" },
      { title: "List a task's output files", href: "/docs/api", anchor: "list-task-files" },
      { title: "Read a task's output file", href: "/docs/api", anchor: "read-task-file" },
    ],
  },
  {
    title: "MCP Server",
    items: [
      { title: "Overview", href: "/docs/mcp", anchor: "overview" },
      { title: "Setup", href: "/docs/mcp", anchor: "setup" },
      { title: "Examples", href: "/docs/mcp", anchor: "examples" },
      { title: "Built-in prompts", href: "/docs/mcp", anchor: "prompts" },
      { title: "Tools reference", href: "/docs/mcp", anchor: "tools" },
      { title: "Security", href: "/docs/mcp", anchor: "security" },
      { title: "Troubleshooting", href: "/docs/mcp", anchor: "troubleshooting" },
    ],
  },
  {
    title: "OpenAI / Anthropic API",
    items: [
      { title: "Overview", href: "/docs/llm-gateway", anchor: "overview" },
      { title: "Setup", href: "/docs/llm-gateway", anchor: "setup" },
      { title: "Choosing a model", href: "/docs/llm-gateway", anchor: "models" },
      { title: "Provider support", href: "/docs/llm-gateway", anchor: "providers" },
      { title: "Endpoints", href: "/docs/llm-gateway", anchor: "endpoints" },
      { title: "Errors", href: "/docs/llm-gateway", anchor: "errors" },
    ],
  },
  // Add future documentation sections here, e.g.:
  // { title: "Guides", items: [{ title: "Self-hosting", href: "/docs/guides/self-hosting" }] },
];
