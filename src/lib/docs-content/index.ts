// Registry of documentation topics served by the MCP `get_docs` tool. Each topic is the same
// content as its /docs page (see the per-topic modules), rendered as markdown for this deployment.
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { buildDocsSearchIndex, type DocsSearchEntry } from "@/lib/docs-search";
import { apiDocsMarkdown } from "./api";
import { llmGatewayMarkdown } from "./llm-gateway";
import { mcpDocsMarkdown, mcpSubAnchors, type McpDocsDefinitions } from "./mcp";

export interface DocsTopic {
  id: string;
  title: string;
  /** Site path of the matching /docs page. */
  path: string;
  summary: string;
  render: (origin: string, mcp: McpDocsDefinitions) => string;
  /**
   * Maps each `##` heading of the rendered markdown to the id of the matching section on the
   * page (`""` = content before the first `##`), so docs search can jump straight to it.
   * Keep in sync with the section ids in src/app/docs/<topic>/page.tsx.
   */
  anchors: Record<string, string>;
  /** Deeper headings with their own id on the page (see DocsSearchSource.subAnchors). */
  subAnchors?: (mcp: McpDocsDefinitions) => Record<string, string>;
}

export const DOCS_TOPICS: DocsTopic[] = [
  {
    id: "api",
    title: "REST API",
    path: "/docs/api",
    summary: "The public REST API (/api/v1): create, start, get, update and list tasks (including review-only tickets that go straight to In Review) and read their output files from your own code. Auth with tm_live_ API keys.",
    render: (origin) => apiDocsMarkdown(origin),
    anchors: {
      "": "overview",
      Authentication: "overview",
      "Base URL": "overview",
      Errors: "overview",
      ...Object.fromEntries(API_ENDPOINTS.map((e) => [e.summary, e.id])),
    },
  },
  {
    id: "llm-gateway",
    title: "OpenAI / Anthropic-compatible API",
    path: "/docs/llm-gateway",
    summary: "Use the Task Manager as a drop-in OpenAI or Anthropic API endpoint that runs on the default AI provider: base URLs, SDK setup, model selection, per-provider support, errors.",
    render: (origin) => llmGatewayMarkdown(origin),
    anchors: {
      "": "overview",
      Setup: "setup",
      "Choosing a model": "models",
      "What works on each provider": "providers",
      Endpoints: "endpoints",
      Errors: "errors",
      "Good to know": "notes",
    },
  },
  {
    id: "mcp",
    title: "MCP server",
    path: "/docs/mcp",
    summary: "This MCP server: token setup, client configuration (Claude Code, Claude Desktop, Cursor, VS Code), example requests, the full tools and prompts reference, security and troubleshooting.",
    render: (origin, mcp) => mcpDocsMarkdown(origin, mcp),
    subAnchors: mcpSubAnchors,
    anchors: {
      "": "overview",
      Setup: "setup",
      Examples: "examples",
      "Built-in prompts": "prompts",
      "Tools reference": "tools",
      Security: "security",
      Troubleshooting: "troubleshooting",
    },
  },
];

export const DOCS_TOPIC_IDS = DOCS_TOPICS.map((t) => t.id);

export function docsTopicIndex(origin: string) {
  const base = origin.replace(/\/+$/, "");
  return DOCS_TOPICS.map((t) => ({ topic: t.id, title: t.title, url: `${base}${t.path}`, summary: t.summary }));
}

/** The topic as markdown, or null for an unknown id. */
export function renderDocsTopic(id: string, origin: string, mcp: McpDocsDefinitions) {
  const topic = DOCS_TOPICS.find((t) => t.id === id);
  if (!topic) return null;
  return {
    topic: topic.id,
    title: topic.title,
    url: `${origin.replace(/\/+$/, "")}${topic.path}`,
    markdown: topic.render(origin, mcp),
  };
}

/** The /docs search index: every topic split into sections (see src/lib/docs-search.ts). */
export function docsSearchIndex(origin: string, mcp: McpDocsDefinitions): DocsSearchEntry[] {
  return buildDocsSearchIndex(
    DOCS_TOPICS.map((t) => ({
      title: t.title,
      path: t.path,
      markdown: t.render(origin, mcp),
      anchors: t.anchors,
      subAnchors: t.subAnchors?.(mcp),
    })),
  );
}
