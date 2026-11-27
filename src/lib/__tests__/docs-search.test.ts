import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDocsSearchIndex, docsHref, plainText, searchDocs } from "../docs-search";
import { DOCS_TOPICS, docsSearchIndex } from "../docs-content";
import type { McpPromptDefinition, McpToolDefinition } from "../mcp/protocol";

const SOURCE = {
  title: "MCP server",
  path: "/docs/mcp",
  anchors: { "": "overview", Setup: "setup", "Tools reference": "tools" },
  markdown: [
    "# MCP server",
    "Connect your **assistant** to the [Task Manager](/docs).",
    "## Setup",
    "Create a token in `Settings → MCP`.",
    "```bash",
    "# not a heading",
    "curl https://example.com/api/mcp",
    "```",
    "### Check it works",
    "Run the cURL snippet.",
    "## Tools reference",
    "### Read tools",
    "#### `get_task` — Get a task (read)",
    "| Argument | Type |",
    "| --- | --- |",
    "| `id` | string \\| null |",
  ].join("\n"),
};

describe("plainText", () => {
  it("strips the inline markdown subset and table syntax", () => {
    assert.equal(plainText("Use **bold**, `code` and [a link](/x)."), "Use bold, code and a link.");
    assert.equal(plainText("| a | b \\| c |\n| --- | --- |"), "a b | c");
  });
});

describe("buildDocsSearchIndex", () => {
  const index = buildDocsSearchIndex([SOURCE]);

  it("splits at headings, ignoring ones inside code fences", () => {
    assert.deepEqual(index.map((e) => e.title), ["MCP server", "Setup", "Check it works", "Tools reference", "Read tools", "get_task — Get a task (read)"]);
    assert.ok(index[1].text.includes("# not a heading"));
  });

  it("links each section to the anchor of its ## section", () => {
    assert.deepEqual(index.map((e) => e.anchor), ["overview", "setup", "setup", "tools", "tools", "tools"]);
    assert.equal(docsHref(index[2]), "/docs/mcp#setup");
    assert.equal(docsHref({ path: "/docs", anchor: null }), "/docs");
  });

  it("uses a sub-section's own anchor when it has one, falling back to its parent's", () => {
    const sub = buildDocsSearchIndex([{ ...SOURCE, subAnchors: { "Read tools": "tools-read", "`get_task` — Get a task (read)": "tool-get_task" } }]);
    assert.deepEqual(sub.map((e) => e.anchor), ["overview", "setup", "setup", "tools", "tools-read", "tool-get_task"]);
    const resets = buildDocsSearchIndex([{ ...SOURCE, markdown: `${SOURCE.markdown}\n## Setup\n### Other`, subAnchors: { "Read tools": "tools-read" } }]);
    assert.deepEqual(resets.slice(-2).map((e) => e.anchor), ["setup", "setup"]);
  });

  it("records ancestor headings as breadcrumbs", () => {
    assert.deepEqual(index[2].breadcrumbs, ["Setup"]);
    assert.deepEqual(index[5].breadcrumbs, ["Tools reference", "Read tools"]);
  });
});

describe("searchDocs", () => {
  const index = buildDocsSearchIndex([SOURCE]);

  it("returns nothing for an empty query", () => {
    assert.deepEqual(searchDocs(index, "   "), []);
  });

  it("ranks title matches above body matches", () => {
    const results = searchDocs(index, "token");
    assert.equal(results[0].entry.title, "Setup");
    const titleHit = searchDocs(index, "get_task");
    assert.equal(titleHit[0].entry.title, "get_task — Get a task (read)");
  });

  it("requires every term to match, case-insensitively", () => {
    assert.deepEqual(searchDocs(index, "CURL snippet").map((r) => r.entry.title), ["Check it works"]);
    assert.deepEqual(searchDocs(index, "curl zebra"), []);
  });

  it("returns a snippet around the match", () => {
    const [hit] = searchDocs(index, "assistant");
    assert.match(hit.snippet, /assistant/);
    assert.equal(hit.href, "/docs/mcp#overview");
  });

  it("respects the limit", () => {
    assert.equal(searchDocs(index, "a", 2).length, 2);
  });
});

describe("docsSearchIndex (real docs)", () => {
  const tool = { name: "list_tasks", title: "List tasks", description: "Lists tasks.", access: "read", inputSchema: { type: "object", properties: {} }, handler: async () => null } as McpToolDefinition<unknown>;
  const index = docsSearchIndex("https://tasks.example.com", { tools: [tool], prompts: [] as McpPromptDefinition[] });

  it("covers every topic and only uses anchors the topic declares", () => {
    for (const topic of DOCS_TOPICS) {
      const entries = index.filter((e) => e.path === topic.path);
      assert.ok(entries.length > 1, topic.id);
      const known = new Set([
        ...Object.values(topic.anchors),
        ...Object.values(topic.subAnchors?.({ tools: [tool], prompts: [] }) ?? {}),
      ]);
      for (const e of entries) assert.ok(e.anchor && known.has(e.anchor), `${topic.id}: "${e.title}" → ${e.anchor}`);
    }
  });

  it("maps every ## heading to an explicit anchor", () => {
    for (const topic of DOCS_TOPICS) {
      const md = topic.render("https://tasks.example.com", { tools: [tool], prompts: [] });
      let fence = false;
      for (const line of md.split("\n")) {
        if (line.startsWith("```")) fence = !fence;
        if (!fence && line.startsWith("## ")) {
          const heading = plainText(line.slice(3));
          assert.ok(heading in topic.anchors, `${topic.id}: no anchor for "${heading}"`);
        }
      }
    }
  });

  it("finds an API endpoint and the MCP tool reference", () => {
    assert.equal(searchDocs(index, "start a task")[0].href, "/docs/api#start-task");
    assert.equal(searchDocs(index, "list_tasks")[0].href, "/docs/mcp#tool-list_tasks");
  });
});
