/**
 * Pure decisions for the LLM gateway: which model a request runs on, and how a conversation
 * is flattened into a prompt for the subscription CLIs (`claude -p`, `codex exec`), which
 * take one prompt rather than a message list.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { modelVendor, providerVendor } from "@/lib/slack-provider";
import { GatewayRequestError } from "./convert";

/** Model ids that always mean "whatever the provider is configured with". */
const DEFAULT_ALIASES = new Set(["", "default", "auto"]);

/**
 * The model to run, given what the client asked for and the provider that will serve it.
 *
 * Clients pointed at the gateway keep sending the model they were built for (`gpt-4o` from an
 * OpenAI integration, `claude-…` from an Anthropic one), but the provider is whatever is the
 * default here. So a requested id is honoured only when it belongs to that provider's vendor;
 * otherwise the provider's own model is used. Unrecognised ids (`llama3`, gateway aliases) are
 * honoured only where custom ids are plausible: an OpenAI-compatible connection or one with a
 * custom base URL. `undefined` means "let the backend use its default".
 */
export function resolveGatewayModel(
  requested: string | null | undefined,
  provider: { type: string; model?: string | null; baseUrl?: string | null },
): string | undefined {
  const wanted = requested?.trim() ?? "";
  const configured = provider.model?.trim() || undefined;
  if (DEFAULT_ALIASES.has(wanted.toLowerCase())) return configured;

  const vendor = modelVendor(wanted);
  if (vendor) return vendor === providerVendor(provider.type) ? wanted : configured;

  const customIdsPlausible = provider.type === "openai" || !!provider.baseUrl?.trim();
  return customIdsPlausible ? wanted : configured;
}

const DEFAULT_CLI_SYSTEM_PROMPT = "You are a helpful assistant.";

/** An image or document the Claude CLI receives as a real content block (stream-json input). */
export type CliAttachment = Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam;

export interface CliPrompt {
  system: string;
  prompt: string;
  /**
   * Images/PDFs, in order. The prompt refers to each as `[attachment N]`; they're sent after it
   * in the same user message. Only the Claude CLI can take them.
   */
  attachments: CliAttachment[];
  /** The CLI's built-in tools to switch on — the stand-ins for the API's server tools. */
  builtinTools: CliBuiltinTool[];
  /** Names of the client tools emulated with <tool_call> blocks (parse the reply when non-empty). */
  clientToolNames: string[];
}

/**
 * API server tools the Claude CLI can run itself, mapped to its built-in tool. `WebSearch` runs
 * on Anthropic's side; `WebFetch` fetches from the worker host, which is what the client asked
 * for by sending `web_fetch`.
 */
export type CliBuiltinTool = "WebSearch" | "WebFetch";
const SERVER_TOOL_PREFIXES: Array<[string, CliBuiltinTool]> = [
  ["web_search_", "WebSearch"],
  ["web_fetch_", "WebFetch"],
];

function serverToolBuiltin(t: Anthropic.ToolUnion): CliBuiltinTool | null {
  const type = (t as { type?: string }).type ?? "";
  return SERVER_TOOL_PREFIXES.find(([prefix]) => type.startsWith(prefix))?.[1] ?? null;
}

function cliRefusal(what: string): GatewayRequestError {
  return new GatewayRequestError(
    `${what} isn't available when the default provider is a subscription CLI. Use an API provider (Settings → AI).`,
  );
}

class PromptBuilder {
  readonly attachments: CliAttachment[] = [];

  attach(block: CliAttachment): string {
    // Cache hints mean nothing to the CLI and are capped at 4 per request.
    const { cache_control: _cc, ...rest } = block as CliAttachment & { cache_control?: unknown };
    void _cc;
    this.attachments.push(rest as CliAttachment);
    return `[attachment ${this.attachments.length}]`;
  }

  text(block: Anthropic.ContentBlockParam): string {
    switch (block.type) {
      case "text":
        return block.text;
      case "image":
        return this.attach(block);
      case "document":
        if (block.source.type === "text") return block.source.data;
        return this.attach(block);
      // Thinking from an earlier turn carries no information the CLI can use.
      case "thinking":
      case "redacted_thinking":
        return "";
      // Earlier tool calls and their results are replayed in the same tag format the model is
      // told to use, so it can follow the loop it's in.
      case "tool_use":
        return `<tool_call>\n${JSON.stringify({ name: block.name, input: block.input ?? {} })}\n</tool_call>`;
      case "tool_result": {
        const content = block.content == null
          ? ""
          : typeof block.content === "string"
            ? block.content
            : block.content.map((b) => this.text(b as Anthropic.ContentBlockParam)).join("\n");
        const attrs = `id="${block.tool_use_id}"${block.is_error ? ' is_error="true"' : ""}`;
        return `<tool_result ${attrs}>\n${content}\n</tool_result>`;
      }
      // A transcript replayed from an API provider: keep what was searched and found as text.
      case "server_tool_use":
        return `[used ${block.name}: ${JSON.stringify(block.input ?? {})}]`;
      case "web_search_tool_result": {
        const c = block.content;
        if (!Array.isArray(c)) return "[web search failed]";
        return `[web search results]\n${c.map((r) => `- ${r.title} (${r.url})`).join("\n")}`;
      }
      default: {
        const type = (block as { type: string }).type;
        if (type === "web_fetch_tool_result") return "[fetched a web page]";
        throw cliRefusal(`'${type}' content`);
      }
    }
  }
}

interface ResolvedTools {
  client: Anthropic.Tool[];
  builtin: Array<{ name: string; tool: CliBuiltinTool; def: Record<string, unknown> }>;
}

function resolveTools(req: Anthropic.MessageCreateParams): ResolvedTools {
  const out: ResolvedTools = { client: [], builtin: [] };
  if (!req.tools?.length || req.tool_choice?.type === "none") return out;
  for (const t of req.tools) {
    const builtin = serverToolBuiltin(t);
    if (builtin) out.builtin.push({ name: t.name, tool: builtin, def: t as unknown as Record<string, unknown> });
    else if ("input_schema" in t && t.input_schema) out.client.push(t as Anthropic.Tool);
    else throw cliRefusal(`The server tool '${t.name}'`);
  }
  return out;
}

/** Limits the API enforces on server tools, passed on as instructions (the CLI tools take the domains as input). */
function builtinToolNotes(builtin: ResolvedTools["builtin"]): string[] {
  const notes: string[] = [];
  for (const { tool, def } of builtin) {
    const label = tool === "WebSearch" ? "web search" : "web fetch";
    const allowed = def.allowed_domains as string[] | undefined;
    const blocked = def.blocked_domains as string[] | undefined;
    if (allowed?.length) notes.push(`Only use ${label} with these domains: ${allowed.join(", ")}.${tool === "WebSearch" ? " Pass them as allowed_domains." : ""}`);
    if (blocked?.length) notes.push(`Never use ${label} with these domains: ${blocked.join(", ")}.${tool === "WebSearch" ? " Pass them as blocked_domains." : ""}`);
    if (typeof def.max_uses === "number") notes.push(`Use ${label} at most ${def.max_uses} times.`);
  }
  return notes;
}

/**
 * The system-prompt section that turns a subscription CLI into a tool-calling model.
 *
 * The CLIs run with their own tools disabled, so the client's tools are emulated: the model is
 * shown each tool's schema and asked to write `<tool_call>` blocks, which
 * parseCliToolCalls() turns back into real `tool_use` blocks. The client runs the tool and
 * sends the result in the next request, exactly as with the API.
 */
function toolsSection(tools: ResolvedTools, choice: Anthropic.MessageCreateParams["tool_choice"]): string {
  const sections: string[] = [];
  const forcedBuiltin = choice?.type === "tool" ? tools.builtin.find((b) => b.name === choice.name) : undefined;

  if (tools.builtin.length) {
    const names = tools.builtin.map((b) => b.tool).join(" and ");
    sections.push(
      "# Built-in tools",
      [
        `Use your ${names} tool${tools.builtin.length > 1 ? "s" : ""} directly whenever current or external information would help.`,
        "Cite the pages you relied on with their URLs.",
        ...builtinToolNotes(tools.builtin),
        forcedBuiltin ? `You must use ${forcedBuiltin.tool} before answering.` : "",
      ].filter(Boolean).join(" "),
    );
  }

  if (tools.client.length) {
    const list = tools.client
      .map((t) => {
        const desc = t.description?.trim() ? `\nDescription: ${t.description.trim()}` : "";
        return `<tool name="${t.name}">${desc}\nInput JSON schema: ${JSON.stringify(t.input_schema)}\n</tool>`;
      })
      .join("\n\n");
    const parallel = choice && "disable_parallel_tool_use" in choice && choice.disable_parallel_tool_use
      ? "Call at most one tool per reply."
      : "You may call several tools in one reply when they don't depend on each other.";
    const must = choice?.type === "any" && !tools.builtin.length
      ? "You must call at least one tool in this reply."
      : choice?.type === "tool" && !forcedBuiltin
        ? `You must call the tool "${choice.name}" in this reply.`
        : "Call a tool only when it helps; otherwise answer normally.";
    sections.push(
      "# Tools",
      "You can call the tools below. You cannot run them yourself — the caller runs them and sends back the results.",
      list,
      "To call a tool, write a block in exactly this format, where the JSON object matches the tool's input schema:",
      '<tool_call>\n{"name": "tool_name", "input": {"arg": "value"}}\n</tool_call>',
      [
        must,
        parallel,
        "Put all tool calls at the end of your reply and stop writing after the last one; the results arrive in the next message, inside <tool_result> blocks.",
        "Never write a <tool_result> block yourself and never invent a tool's output.",
        "Don't wrap tool calls in code fences.",
      ].join(" "),
    );
  }
  return sections.join("\n\n");
}

/**
 * Flattens an Anthropic-format request into a system prompt and one `-p` prompt.
 *
 * Client tools are emulated (see toolsSection()), web search/fetch run on the CLI's own tools,
 * and images/PDFs travel as attachments. Anything else (code execution, other server tools)
 * is refused rather than ignored, so a client never gets a confident answer to a question it
 * couldn't ask. A single user turn is passed through verbatim; a longer conversation becomes a
 * transcript ending on the turn the model should answer.
 */
export function buildCliPrompt(req: Anthropic.MessageCreateParams): CliPrompt {
  const tools = resolveTools(req);
  const builder = new PromptBuilder();

  const systemParts: string[] = [];
  if (typeof req.system === "string") systemParts.push(req.system);
  else if (req.system) systemParts.push(...req.system.map((b) => b.text));

  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const msg of req.messages) {
    const role = msg.role as string;
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content } as Anthropic.TextBlockParam] : msg.content;
    const text = blocks.map((b) => builder.text(b)).join("\n").trim();
    if (role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === msg.role) last.text += `\n\n${text}`;
    else turns.push({ role: msg.role, text });
  }

  if (!turns.length || turns[turns.length - 1].role !== "user") {
    throw new GatewayRequestError("The conversation must end with a user message.");
  }

  if (tools.client.length || tools.builtin.length) systemParts.push(toolsSection(tools, req.tool_choice));
  const result = {
    system: systemParts.join("\n\n").trim() || DEFAULT_CLI_SYSTEM_PROMPT,
    attachments: builder.attachments,
    builtinTools: [...new Set(tools.builtin.map((b) => b.tool))],
    clientToolNames: tools.client.map((t) => t.name),
  };
  if (turns.length === 1) return { ...result, prompt: turns[0].text };

  const transcript = turns
    .slice(0, -1)
    .map((t) => `<${t.role}>\n${t.text}\n</${t.role}>`)
    .join("\n\n");
  const prompt =
    `Earlier turns of this conversation:\n\n${transcript}\n\n` +
    `Reply to the user's latest message below as the assistant. Write only your reply.\n\n${turns[turns.length - 1].text}`;
  return { ...result, prompt };
}

const TOOL_CALL_RE = /(?:```[a-z]*\s*)?<tool_call>\s*([\s\S]*?)\s*<\/tool_call>(?:\s*```)?/g;

function newToolUseId(): string {
  return `toolu_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

/**
 * Turns the `<tool_call>` blocks a CLI wrote back into `tool_use` content blocks.
 *
 * Text before, between and after the calls is kept as text blocks. A block whose JSON doesn't
 * parse, or that names a tool the client didn't offer, stays as text — better the client sees
 * what the model wrote than a call it can't dispatch. If the model went on to imagine a
 * `<tool_result>`, everything from there is dropped: the real result comes from the client.
 */
export function parseCliToolCalls(
  text: string,
  toolNames: Iterable<string>,
): { content: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock>; hasToolUse: boolean } {
  const names = new Set(toolNames);
  const content: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock> = [];
  let hasToolUse = false;
  const pushText = (t: string) => {
    const trimmed = t.trim();
    if (!trimmed) return;
    const last = content[content.length - 1];
    if (last?.type === "text") last.text += `\n\n${trimmed}`;
    else content.push({ type: "text", text: trimmed, citations: null });
  };

  let cursor = 0;
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    const start = m.index ?? 0;
    const before = text.slice(cursor, start);
    cursor = start + m[0].length;
    let call: { name?: unknown; input?: unknown; arguments?: unknown } | null = null;
    try {
      call = JSON.parse(m[1]);
    } catch {
      call = null;
    }
    const input = call?.input ?? call?.arguments ?? {};
    if (
      call && typeof call.name === "string" && names.has(call.name) &&
      input && typeof input === "object" && !Array.isArray(input)
    ) {
      pushText(before);
      content.push({ type: "tool_use", id: newToolUseId(), name: call.name, input } as Anthropic.ToolUseBlock);
      hasToolUse = true;
    } else {
      pushText(before + m[0]);
    }
  }
  let rest = text.slice(cursor);
  if (hasToolUse) {
    const fake = rest.indexOf("<tool_result");
    if (fake >= 0) rest = rest.slice(0, fake);
  }
  pushText(rest);
  return { content, hasToolUse };
}

/**
 * A CLI's finished reply with its `<tool_call>` text rewritten into `tool_use` blocks and
 * `stop_reason: "tool_use"` when it called anything. Thinking blocks are kept in front.
 */
export function applyCliToolCalls(msg: Anthropic.Message, toolNames: Iterable<string>): Anthropic.Message {
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const other = msg.content.filter((b) => b.type !== "text");
  const { content, hasToolUse } = parseCliToolCalls(text, toolNames);
  return {
    ...msg,
    content: [...other, ...content],
    stop_reason: hasToolUse ? "tool_use" : msg.stop_reason,
    stop_sequence: hasToolUse ? null : msg.stop_sequence,
  };
}
