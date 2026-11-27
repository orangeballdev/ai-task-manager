import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOCS_TOPICS, DOCS_TOPIC_IDS, docsTopicIndex, renderDocsTopic } from "../docs-content";
import { absoluteLinks, mdTable } from "../docs-content/markdown";
import { API_ENDPOINTS } from "../api-endpoints";
import type { McpPromptDefinition, McpToolDefinition } from "../mcp/protocol";

const ORIGIN = "https://tasks.example.com";

const fakeTool = (name: string, access: "read" | "write"): McpToolDefinition<unknown> => ({
  name,
  title: `Title of ${name}`,
  description: `Does ${name}.`,
  access,
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", enum: ["a", "b"], description: "Which one | pipes escaped." },
      maybe: { type: ["number", "null"], description: "Nullable." },
    },
    required: ["topic"],
  },
  handler: async () => null,
});
const defs = {
  tools: [fakeTool("read_thing", "read"), fakeTool("write_thing", "write")],
  prompts: [{ name: "a_prompt", title: "A", description: "Prompt desc", access: "read", render: () => "" }] as McpPromptDefinition[],
};

describe("markdown helpers", () => {
  it("escapes pipes in table cells", () => {
    assert.equal(mdTable(["a"], [["x | y"]]), "| a |\n| --- |\n| x \\| y |");
  });
  it("makes site-relative links absolute and leaves others alone", () => {
    assert.equal(
      absoluteLinks("[S](/settings/api) and [E](https://e.x/a)", `${ORIGIN}/`),
      `[S](${ORIGIN}/settings/api) and [E](https://e.x/a)`,
    );
  });
});

describe("docs topics", () => {
  it("indexes every topic with an absolute URL", () => {
    const index = docsTopicIndex(ORIGIN);
    assert.deepEqual(index.map((t) => t.topic), DOCS_TOPIC_IDS);
    for (const t of index) assert.ok(t.url.startsWith(`${ORIGIN}/docs/`), t.url);
  });

  it("returns null for an unknown topic", () => {
    assert.equal(renderDocsTopic("nope", ORIGIN, defs), null);
  });

  for (const topic of DOCS_TOPICS) {
    it(`renders ${topic.id} with no site-relative links left`, () => {
      const doc = renderDocsTopic(topic.id, ORIGIN, defs);
      assert.ok(doc && doc.markdown.startsWith("# "));
      assert.doesNotMatch(doc.markdown, /\]\(\//);
    });
  }

  it("api docs cover every endpoint", () => {
    const md = renderDocsTopic("api", ORIGIN, defs)!.markdown;
    for (const e of API_ENDPOINTS) assert.ok(md.includes(`\`${e.method} ${e.path}\``), e.path);
    assert.ok(md.includes(`${ORIGIN}/api/v1`));
  });

  it("gateway docs use this deployment's base URLs", () => {
    const md = renderDocsTopic("llm-gateway", ORIGIN, defs)!.markdown;
    assert.ok(md.includes(`base_url="${ORIGIN}/api/llm/v1"`));
    assert.ok(md.includes(`base_url="${ORIGIN}/api/llm"`));
  });

  it("mcp docs are generated from the tool and prompt definitions passed in", () => {
    const md = renderDocsTopic("mcp", ORIGIN, defs)!.markdown;
    assert.ok(md.includes("`read_thing` — Title of read_thing (read)"));
    assert.ok(md.includes("`write_thing` — Title of write_thing (write)"));
    assert.ok(md.includes('| `topic` | "a" \\| "b" | yes | Which one \\| pipes escaped. |'));
    assert.ok(md.includes('| `maybe` | number \\| null |  | Nullable. |'));
    assert.ok(md.includes("`a_prompt`"));
    assert.ok(md.includes(`${ORIGIN}/api/mcp`));
  });
});
