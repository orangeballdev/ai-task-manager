import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleMcpMessage,
  handleMcpPayload,
  negotiateProtocolVersion,
  LATEST_PROTOCOL_VERSION,
  McpToolError,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INVALID_REQUEST,
  argString,
  argNumber,
  argStringList,
  argEnum,
  argBoolean,
  truncate,
  type McpServerConfig,
} from "../mcp/protocol";
import {
  accessAllows,
  extractBearerToken,
  generateMcpToken,
  hashMcpToken,
  normalizeMcpAccess,
  MCP_TOKEN_PREFIX,
} from "../mcp/tokens";

type Ctx = { calls: string[] };

function config(): McpServerConfig<Ctx> {
  return {
    instructions: "Test server.",
    tools: [
      {
        name: "read_thing",
        title: "Read",
        description: "reads",
        access: "read",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        handler: async (args, ctx) => {
          ctx.calls.push("read_thing");
          return { id: argString(args, "id", { required: true }) };
        },
      },
      {
        name: "write_thing",
        title: "Write",
        description: "writes",
        access: "write",
        inputSchema: { type: "object" },
        handler: async (_args, ctx) => {
          ctx.calls.push("write_thing");
          return "done";
        },
      },
      {
        name: "boom",
        title: "Boom",
        description: "throws",
        access: "read",
        inputSchema: { type: "object" },
        handler: async () => {
          throw new Error("kaput");
        },
      },
    ],
    prompts: [
      {
        name: "p_read",
        title: "Read prompt",
        description: "d",
        access: "read",
        arguments: [{ name: "taskId", required: true }],
        render: ({ taskId }) => `Look at ${taskId}`,
      },
      { name: "p_write", title: "Write prompt", description: "d", access: "write", render: () => "go" },
    ],
  };
}

const req = (access: "read" | "write") => ({ access, ctx: { calls: [] as string[] } });

test("initialize echoes a supported protocol version and falls back to the latest", async () => {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    config(),
    req("write"),
  );
  const result = res!.result as { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } };
  assert.equal(result.protocolVersion, "2025-03-26");
  assert.ok(result.capabilities.tools);
  assert.ok(result.capabilities.prompts);
  assert.equal(result.serverInfo.name, "ai-task-manager");
  assert.equal(negotiateProtocolVersion("1999-01-01"), LATEST_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(undefined), LATEST_PROTOCOL_VERSION);
});

test("initialize tells read-only clients they're read-only", async () => {
  const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, config(), req("read"));
  assert.match((res!.result as { instructions: string }).instructions, /READ-ONLY/);
  const rw = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, config(), req("write"));
  assert.doesNotMatch((rw!.result as { instructions: string }).instructions, /READ-ONLY/);
});

test("notifications and client responses get no reply", async () => {
  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, config(), req("read")), null);
  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", id: 5, result: {} }, config(), req("read")), null);
});

test("invalid messages are rejected with INVALID_REQUEST", async () => {
  const res = await handleMcpMessage({ id: 1, method: "ping" }, config(), req("read"));
  assert.equal(res!.error!.code, INVALID_REQUEST);
  const res2 = await handleMcpMessage("nope", config(), req("read"));
  assert.equal(res2!.error!.code, INVALID_REQUEST);
});

test("ping and unknown methods", async () => {
  const ping = await handleMcpMessage({ jsonrpc: "2.0", id: "a", method: "ping" }, config(), req("read"));
  assert.deepEqual(ping, { jsonrpc: "2.0", id: "a", result: {} });
  const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "nope/nope" }, config(), req("read"));
  assert.equal(unknown!.error!.code, METHOD_NOT_FOUND);
});

test("tools/list hides write tools from read-only tokens", async () => {
  const read = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, config(), req("read"));
  const readNames = (read!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.deepEqual(readNames, ["read_thing", "boom"]);

  const write = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, config(), req("write"));
  const tools = (write!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
  assert.deepEqual(tools.map((t) => t.name), ["read_thing", "write_thing", "boom"]);
  assert.equal(tools.find((t) => t.name === "write_thing")!.annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === "read_thing")!.annotations.readOnlyHint, true);
});

test("tools/call refuses write tools for read-only tokens without running them", async () => {
  const r = req("read");
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_thing", arguments: {} } },
    config(),
    r,
  );
  assert.equal(res!.error!.code, INVALID_PARAMS);
  assert.match(res!.error!.message, /read-only/);
  assert.deepEqual(r.ctx.calls, []);
});

test("tools/call returns text + structured content", async () => {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_thing", arguments: { id: "t1" } } },
    config(),
    req("read"),
  );
  const result = res!.result as { content: { type: string; text: string }[]; structuredContent: unknown; isError?: boolean };
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { id: "t1" });
  assert.deepEqual(JSON.parse(result.content[0].text), { id: "t1" });
});

test("tool errors come back as isError results, not protocol errors", async () => {
  const bad = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_thing", arguments: {} } },
    config(),
    req("read"),
  );
  const r1 = bad!.result as { isError: boolean; content: { text: string }[] };
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /'id' is required/);

  const errors: string[] = [];
  const cfg = { ...config(), onError: (_e: unknown, tool: string) => errors.push(tool) };
  const boom = await handleMcpMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "boom" } },
    cfg,
    req("read"),
  );
  const r2 = boom!.result as { isError: boolean; content: { text: string }[] };
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /kaput/);
  assert.deepEqual(errors, ["boom"]);
});

test("unknown tool is INVALID_PARAMS", async () => {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "missing" } },
    config(),
    req("write"),
  );
  assert.equal(res!.error!.code, INVALID_PARAMS);
});

test("prompts are filtered by access and validate required arguments", async () => {
  const list = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "prompts/list" }, config(), req("read"));
  assert.deepEqual((list!.result as { prompts: { name: string }[] }).prompts.map((p) => p.name), ["p_read"]);

  const hidden = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "p_write" } },
    config(),
    req("read"),
  );
  assert.equal(hidden!.error!.code, INVALID_PARAMS);

  const missing = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "p_read", arguments: {} } },
    config(),
    req("read"),
  );
  assert.match(missing!.error!.message, /taskId/);

  const ok = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "p_read", arguments: { taskId: "abc" } } },
    config(),
    req("read"),
  );
  const messages = (ok!.result as { messages: { role: string; content: { text: string } }[] }).messages;
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.text, "Look at abc");
});

test("batches return only the replies that need one", async () => {
  const res = await handleMcpPayload(
    [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ],
    config(),
    req("read"),
  );
  assert.ok(Array.isArray(res));
  assert.deepEqual((res as { id: number }[]).map((r) => r.id), [1, 2]);

  const onlyNotifications = await handleMcpPayload([{ jsonrpc: "2.0", method: "notifications/initialized" }], config(), req("read"));
  assert.equal(onlyNotifications, null);
});

test("argument helpers", () => {
  assert.equal(argString({ a: "  x " }, "a"), "x");
  assert.equal(argString({ a: "  " }, "a"), undefined);
  assert.throws(() => argString({}, "a", { required: true }), McpToolError);
  assert.throws(() => argString({ a: 1 }, "a"), McpToolError);
  assert.equal(argNumber({ n: "5" }, "n"), 5);
  assert.equal(argNumber({ n: 5.7 }, "n", { integer: true }), 5);
  assert.throws(() => argNumber({ n: 500 }, "n", { max: 100 }), McpToolError);
  assert.throws(() => argNumber({ n: "x" }, "n"), McpToolError);
  assert.deepEqual(argStringList({ l: "one" }, "l"), ["one"]);
  assert.deepEqual(argStringList({ l: [" a ", "", "b"] }, "l"), ["a", "b"]);
  assert.throws(() => argStringList({ l: [1] }, "l"), McpToolError);
  assert.equal(argEnum({ e: "b" }, "e", ["a", "b"] as const), "b");
  assert.throws(() => argEnum({ e: "c" }, "e", ["a", "b"] as const), McpToolError);
  assert.equal(argBoolean({ b: "true" }, "b"), true);
  assert.equal(argBoolean({}, "b"), undefined);
  assert.throws(() => argBoolean({ b: "yes" }, "b"), McpToolError);
  assert.equal(truncate("abcdef", 3), "abc… [truncated 3 chars]");
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate(null, 3), null);
});

test("token helpers", () => {
  const { token, keyHash, keyPrefix } = generateMcpToken();
  assert.ok(token.startsWith(MCP_TOKEN_PREFIX));
  assert.equal(token.length, MCP_TOKEN_PREFIX.length + 48);
  assert.equal(keyHash, hashMcpToken(token));
  assert.equal(hashMcpToken(` ${token} `), keyHash);
  assert.ok(keyPrefix.startsWith(MCP_TOKEN_PREFIX) && keyPrefix.includes("…"));
  assert.ok(!keyPrefix.includes(token.slice(MCP_TOKEN_PREFIX.length + 4, -4)));

  assert.equal(extractBearerToken("Bearer abc"), "abc");
  assert.equal(extractBearerToken("bearer   abc  "), "abc");
  assert.equal(extractBearerToken("Basic abc"), null);
  assert.equal(extractBearerToken(null), null);

  assert.equal(normalizeMcpAccess("write"), "write");
  assert.equal(normalizeMcpAccess("admin"), "read");
  assert.equal(accessAllows("read", "read"), true);
  assert.equal(accessAllows("read", "write"), false);
  assert.equal(accessAllows("write", "write"), true);
  assert.equal(accessAllows("write", "read"), true);
});
