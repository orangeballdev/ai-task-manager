// Minimal, dependency-free Model Context Protocol server core.
//
// This is the pure half of the MCP server: JSON-RPC 2.0 dispatch, protocol version
// negotiation, and the tools/prompts surface, with every tool's I/O injected. The
// HTTP transport (Streamable HTTP, stateless, JSON responses) is
// src/app/api/mcp/route.ts and the actual task tools are src/lib/mcp/tools.ts.
//
// Access control happens here, not in each tool: a tool declares the access it needs
// ("read" | "write") and a token without it neither *sees* the tool in tools/list nor
// can call it — a read-only token asking for `create_task` gets the same "unknown
// tool" error as for a tool that doesn't exist, plus a hint about the scope.
import { accessAllows, type McpAccess } from "./tokens";

export const MCP_SERVER_NAME = "ai-task-manager";
export const MCP_SERVER_VERSION = "1.0.0";

/** Newest first. A client asking for one of these gets it echoed back. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// JSON-RPC 2.0 error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** JSON Schema for a tool's arguments (always an object schema). */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpToolDefinition<Ctx = unknown> {
  name: string;
  title: string;
  description: string;
  /** Access a token needs to see and call this tool. */
  access: McpAccess;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDefinition {
  name: string;
  title: string;
  description: string;
  /** Prompts that drive write tools are hidden from read-only tokens too. */
  access: McpAccess;
  arguments?: McpPromptArgument[];
  /** Returns the user message text for prompts/get. */
  render: (args: Record<string, string>) => string;
}

/**
 * Thrown by a tool handler for an expected, user-facing failure ("no task with that id",
 * "task is running"). Reported as a tool result with `isError: true` so the model can
 * read it and recover, rather than as a protocol error.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

export interface McpServerConfig<Ctx> {
  tools: McpToolDefinition<Ctx>[];
  prompts?: McpPromptDefinition[];
  /** Shown to the client at initialize time — guidance for the model. */
  instructions?: string;
  /** Called for unexpected handler errors (not McpToolError). */
  onError?: (err: unknown, tool: string) => void;
}

export interface McpRequestContext<Ctx> {
  access: McpAccess;
  ctx: Ctx;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined && { data }) } };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/** The tools a token with `access` can see, in their tools/list wire shape. */
export function listToolsFor<Ctx>(tools: McpToolDefinition<Ctx>[], access: McpAccess) {
  return tools
    .filter((t) => accessAllows(access, t.access))
    .map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        title: t.title,
        readOnlyHint: t.access === "read",
        ...t.annotations,
      },
    }));
}

/** Wraps whatever a tool handler returned in an MCP CallToolResult. */
export function toToolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(isObject(value) && { structuredContent: value }),
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Handles one JSON-RPC message. Returns the response to send, or null for
 * notifications and client responses (which get no reply).
 */
export async function handleMcpMessage<Ctx>(
  message: unknown,
  config: McpServerConfig<Ctx>,
  request: McpRequestContext<Ctx>,
): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    const id = isObject(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
    return rpcError(id, INVALID_REQUEST, "Invalid JSON-RPC 2.0 message.");
  }

  const hasId = "id" in message && message.id !== undefined;
  const method = typeof message.method === "string" ? message.method : undefined;

  // A response from the client (we never send requests, so just ignore it) or a
  // notification such as notifications/initialized / notifications/cancelled.
  if (!method) return hasId ? null : rpcError(null, INVALID_REQUEST, "Missing method.");
  if (!hasId) return null;

  const id = message.id as JsonRpcId;
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    return rpcError(null, INVALID_REQUEST, "Invalid id.");
  }
  const params = isObject(message.params) ? message.params : {};

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
          ...(config.prompts?.length ? { prompts: { listChanged: false } } : {}),
        },
        serverInfo: { name: MCP_SERVER_NAME, title: "AI Task Manager", version: MCP_SERVER_VERSION },
        ...(config.instructions && {
          instructions:
            config.instructions +
            (request.access === "read"
              ? "\n\nThis connection uses a READ-ONLY token: you can look tasks up and answer questions about them, but not create or change them."
              : ""),
        }),
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: listToolsFor(config.tools, request.access) });

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = config.tools.find((t) => t.name === name);
      if (!tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name || "(missing name)"}`);
      if (!accessAllows(request.access, tool.access)) {
        return rpcError(
          id,
          INVALID_PARAMS,
          `Unknown tool: ${name}. This MCP token is read-only — create a "Read & write" token under Settings → MCP to use write tools.`,
        );
      }
      const args = isObject(params.arguments) ? params.arguments : {};
      try {
        const value = await tool.handler(args, request.ctx);
        return rpcResult(id, toToolResult(value));
      } catch (err) {
        if (err instanceof McpToolError) return rpcResult(id, toolErrorResult(err.message));
        config.onError?.(err, name);
        const msg = err instanceof Error ? err.message : String(err);
        return rpcResult(id, toolErrorResult(`Tool '${name}' failed: ${msg}`));
      }
    }

    case "prompts/list": {
      const prompts = (config.prompts ?? [])
        .filter((p) => accessAllows(request.access, p.access))
        .map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments ?? [] }));
      return rpcResult(id, { prompts });
    }

    case "prompts/get": {
      const name = typeof params.name === "string" ? params.name : "";
      const prompt = (config.prompts ?? []).find((p) => p.name === name && accessAllows(request.access, p.access));
      if (!prompt) return rpcError(id, INVALID_PARAMS, `Unknown prompt: ${name || "(missing name)"}`);
      const rawArgs = isObject(params.arguments) ? params.arguments : {};
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawArgs)) if (v !== undefined && v !== null) args[k] = String(v);
      const missing = (prompt.arguments ?? []).filter((a) => a.required && !args[a.name]?.trim()).map((a) => a.name);
      if (missing.length) return rpcError(id, INVALID_PARAMS, `Missing required argument(s): ${missing.join(", ")}`);
      return rpcResult(id, {
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text: prompt.render(args) } }],
      });
    }

    // We advertise neither, but some clients probe them; answer with empty lists
    // rather than an error so they don't log noise.
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: [] });

    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * Handles a POST body: a single message or (pre-2025-06-18 clients) a batch.
 * Returns null when nothing needs a reply (HTTP 202).
 */
export async function handleMcpPayload<Ctx>(
  payload: unknown,
  config: McpServerConfig<Ctx>,
  request: McpRequestContext<Ctx>,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return rpcError(null, INVALID_REQUEST, "Empty batch.");
    const responses: JsonRpcResponse[] = [];
    for (const msg of payload) {
      const res = await handleMcpMessage(msg, config, request);
      if (res) responses.push(res);
    }
    return responses.length ? responses : null;
  }
  return handleMcpMessage(payload, config, request);
}

export function parseErrorResponse(): JsonRpcResponse {
  return rpcError(null, PARSE_ERROR, "Parse error: body must be valid JSON.");
}

// ---------------------------------------------------------------------------
// Argument helpers for tool handlers. They throw McpToolError so a bad argument
// comes back to the model as a readable tool error it can fix and retry.
// ---------------------------------------------------------------------------

export function argString(args: Record<string, unknown>, key: string, opts: { required: true }): string;
export function argString(args: Record<string, unknown>, key: string, opts?: { required?: false }): string | undefined;
export function argString(args: Record<string, unknown>, key: string, opts: { required?: boolean } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (opts.required) throw new McpToolError(`'${key}' is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new McpToolError(`'${key}' must be a string.`);
  return v.trim();
}

export function argNumber(
  args: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new McpToolError(`'${key}' must be a number.`);
  const val = opts.integer ? Math.floor(n) : n;
  if (opts.min !== undefined && val < opts.min) throw new McpToolError(`'${key}' must be at least ${opts.min}.`);
  if (opts.max !== undefined && val > opts.max) throw new McpToolError(`'${key}' must be at most ${opts.max}.`);
  return val;
}

export function argBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new McpToolError(`'${key}' must be true or false.`);
}

/** Accepts an array of strings, or a single string (treated as a one-item list). */
export function argStringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((x) => typeof x === "string")) throw new McpToolError(`'${key}' must be a list of strings.`);
  return (list as string[]).map((s) => s.trim()).filter(Boolean);
}

export function argEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const v = argString(args, key);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new McpToolError(`'${key}' must be one of: ${allowed.join(", ")}.`);
  }
  return v as T;
}

/** Trims long text so one huge log line or description can't blow the model's context. */
export function truncate(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}
