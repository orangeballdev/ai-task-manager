/**
 * Unit tests for external MCP servers given to agents (src/lib/mcp-servers.ts).
 *
 * Run with:
 *   npx tsx --test src/lib/__tests__/mcp-servers.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MCP_SECRET_MASK,
  buildClaudeMcpConfig,
  buildCodexMcpArgs,
  buildMcpServersPrompt,
  formatKeyValueLines,
  parseKeyValueLines,
  providerSupportsMcp,
  rowToConfig,
  toPublicMcpServer,
  validateMcpServerInput,
  type McpServerConfig,
  type McpServerRow,
} from "../mcp-servers";

function row(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "s1",
    name: "pg",
    description: null,
    transport: "stdio",
    command: "npx",
    args: JSON.stringify(["-y", "server-postgres"]),
    env: JSON.stringify({ PGPASSWORD: "secret" }),
    url: null,
    headers: "{}",
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const stdio: McpServerConfig = { name: "pg", transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "a\"b" }, headers: {} };
const http: McpServerConfig = { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", args: [], env: {}, headers: { Authorization: "Bearer x" } };
const sse: McpServerConfig = { name: "old", transport: "sse", url: "https://example.com/sse", args: [], env: {}, headers: {} };

describe("validateMcpServerInput", () => {
  it("accepts a stdio server", () => {
    const r = validateMcpServerInput({ name: "pg", transport: "stdio", command: " npx ", args: ["-y", "pkg"], env: { A: "1" } });
    assert.ok(r.ok);
    assert.equal(r.data.command, "npx");
    assert.deepEqual(JSON.parse(r.data.args), ["-y", "pkg"]);
    assert.deepEqual(JSON.parse(r.data.env), { A: "1" });
    assert.equal(r.data.url, null);
    assert.equal(r.data.enabled, true);
  });

  it("accepts a remote server and drops stdio fields", () => {
    const r = validateMcpServerInput({ name: "linear", transport: "http", url: "https://x.dev/mcp", command: "ignored", headers: { Authorization: "Bearer t" } });
    assert.ok(r.ok);
    assert.equal(r.data.command, null);
    assert.equal(r.data.url, "https://x.dev/mcp");
    assert.deepEqual(JSON.parse(r.data.headers), { Authorization: "Bearer t" });
  });

  it("rejects bad names, transports, missing command/url and bad keys", () => {
    assert.equal(validateMcpServerInput({ name: "has space", command: "x" }).ok, false);
    assert.equal(validateMcpServerInput({ name: "a.b", command: "x" }).ok, false);
    assert.equal(validateMcpServerInput({ name: "ok", transport: "ws", command: "x" }).ok, false);
    assert.equal(validateMcpServerInput({ name: "ok", transport: "stdio" }).ok, false);
    assert.equal(validateMcpServerInput({ name: "ok", transport: "http", url: "not a url" }).ok, false);
    assert.equal(validateMcpServerInput({ name: "ok", transport: "http", url: "ftp://x" }).ok, false);
    assert.equal(validateMcpServerInput({ name: "ok", command: "x", env: { "BAD-KEY": "1" } }).ok, false);
    assert.equal(validateMcpServerInput({ name: "ok", command: "x", args: "nope" }).ok, false);
    assert.equal(validateMcpServerInput(null).ok, false);
  });

  it("keeps stored fields on partial update and masked secrets", () => {
    const existing = row();
    const r = validateMcpServerInput({ enabled: false, env: { PGPASSWORD: MCP_SECRET_MASK, NEW: "v" } }, existing);
    assert.ok(r.ok);
    assert.equal(r.data.name, "pg");
    assert.equal(r.data.command, "npx");
    assert.equal(r.data.enabled, false);
    assert.deepEqual(JSON.parse(r.data.args), ["-y", "server-postgres"]);
    assert.deepEqual(JSON.parse(r.data.env), { PGPASSWORD: "secret", NEW: "v" });
  });

  it("removes secrets left out of an update", () => {
    const r = validateMcpServerInput({ env: {} }, row());
    assert.ok(r.ok);
    assert.deepEqual(JSON.parse(r.data.env), {});
  });
});

describe("toPublicMcpServer", () => {
  it("masks env and header values", () => {
    const pub = toPublicMcpServer(row({ headers: JSON.stringify({ Authorization: "Bearer t" }) }));
    assert.deepEqual(pub.env, { PGPASSWORD: MCP_SECRET_MASK });
    assert.deepEqual(pub.headers, { Authorization: MCP_SECRET_MASK });
    assert.deepEqual(pub.args, ["-y", "server-postgres"]);
  });

  it("tolerates corrupt JSON columns", () => {
    const cfg = rowToConfig(row({ args: "nope", env: "[1]", transport: "weird" }));
    assert.deepEqual(cfg.args, []);
    assert.deepEqual(cfg.env, {});
    assert.equal(cfg.transport, "stdio");
  });
});

describe("parseKeyValueLines / formatKeyValueLines", () => {
  it("parses env and header lines, skipping blanks and comments", () => {
    assert.deepEqual(parseKeyValueLines("A=1\n\n# c\nB = x=y ", "env"), { ok: true, value: { A: "1", B: "x=y" } });
    assert.deepEqual(parseKeyValueLines("Authorization: Bearer a:b", "headers"), { ok: true, value: { Authorization: "Bearer a:b" } });
  });

  it("reports bad lines", () => {
    assert.equal(parseKeyValueLines("novalue", "env").ok, false);
    assert.equal(parseKeyValueLines("1BAD=x", "env").ok, false);
    assert.equal(parseKeyValueLines("Bad Header: x", "headers").ok, false);
  });

  it("round-trips", () => {
    const env = { A: "1", B: MCP_SECRET_MASK };
    const parsed = parseKeyValueLines(formatKeyValueLines(env, "env"), "env");
    assert.deepEqual(parsed, { ok: true, value: env });
    const headers = { "X-Key": "v" };
    assert.deepEqual(parseKeyValueLines(formatKeyValueLines(headers, "headers"), "headers"), { ok: true, value: headers });
  });
});

describe("buildClaudeMcpConfig", () => {
  it("emits stdio, http and sse entries", () => {
    assert.deepEqual(buildClaudeMcpConfig([stdio, http, sse]), {
      mcpServers: {
        pg: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "a\"b" } },
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer x" } },
        old: { type: "sse", url: "https://example.com/sse" },
      },
    });
  });
});

describe("buildCodexMcpArgs", () => {
  it("emits --config overrides and skips SSE", () => {
    const { args, skipped } = buildCodexMcpArgs([stdio, http, sse]);
    assert.deepEqual(skipped, ["old"]);
    assert.deepEqual(args, [
      "--config", 'mcp_servers.pg.command="npx"',
      "--config", 'mcp_servers.pg.args=["-y", "pkg"]',
      "--config", 'mcp_servers.pg.env={ "TOKEN" = "a\\"b" }',
      "--config", 'mcp_servers.linear.url="https://mcp.linear.app/mcp"',
      "--config", 'mcp_servers.linear.http_headers={ "Authorization" = "Bearer x" }',
    ]);
  });
});

describe("buildMcpServersPrompt / providerSupportsMcp", () => {
  it("lists servers, empty for none", () => {
    assert.equal(buildMcpServersPrompt([]), "");
    const p = buildMcpServersPrompt([{ name: "pg", description: "Prod read replica", transport: "stdio" }]);
    assert.match(p, /## MCP Servers/);
    assert.match(p, /\*\*pg\*\* — Prod read replica/);
  });

  it("only CLI providers support MCP", () => {
    assert.equal(providerSupportsMcp("cli"), true);
    assert.equal(providerSupportsMcp("codex-cli"), true);
    assert.equal(providerSupportsMcp("api"), false);
    assert.equal(providerSupportsMcp("openai"), false);
  });
});
