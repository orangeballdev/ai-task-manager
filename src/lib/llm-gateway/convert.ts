/**
 * Pure translation between the OpenAI Chat Completions and Anthropic Messages wire formats,
 * used by the LLM gateway (`/api/llm/v1/*`, see src/lib/llm-gateway/backends.ts).
 *
 * The gateway accepts either format and runs it on whatever provider getProvider() resolves.
 * A request whose format matches the provider's API is passed through untouched; only a
 * mismatch (OpenAI request → Claude provider, Anthropic request → OpenAI provider, or any
 * request → a subscription CLI, which speaks Anthropic events) goes through this file.
 *
 * Anthropic is the pivot: CLI output and the Claude API both produce Anthropic messages and
 * stream events, so OpenAI responses are always derived from those.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { MIN_ASSISTANT_MAX_TOKENS } from "@/lib/anthropic-reply";
import { modelSupportsEffort } from "@/lib/models";

type OAIRequest = OpenAI.Chat.ChatCompletionCreateParams;
type OAIMessage = OpenAI.Chat.ChatCompletionMessageParam;
type OAICompletion = OpenAI.Chat.ChatCompletion;
type OAIChunk = OpenAI.Chat.ChatCompletionChunk;
type FinishReason = OpenAI.Chat.ChatCompletionChunk.Choice["finish_reason"];
type ChunkDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta;
type AMessageParam = Anthropic.MessageParam;
type ABlockParam = Anthropic.ContentBlockParam;
type AEvent = Anthropic.RawMessageStreamEvent;

/** A request the gateway can't express in the target format — answered with a 400. */
export class GatewayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function safeJsonParse(text: string | undefined | null): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: text };
  }
}

/** Text of an OpenAI content value (string or parts), images excluded. */
function openaiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: { type?: string; text?: string; refusal?: string }) =>
      p?.type === "text" ? p.text ?? "" : p?.type === "refusal" ? p.refusal ?? "" : "")
    .join("");
}

const STOP_TO_FINISH: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

export function anthropicStopToOpenAI(stop: string | null | undefined): FinishReason {
  return (stop && STOP_TO_FINISH[stop]) || "stop";
}

export function openaiFinishToAnthropic(finish: string | null | undefined): Anthropic.StopReason {
  switch (finish) {
    case "length": return "max_tokens";
    case "tool_calls":
    case "function_call": return "tool_use";
    case "content_filter": return "refusal";
    default: return "end_turn";
  }
}

const OPENAI_EFFORT: Record<string, "low" | "medium" | "high"> = {
  minimal: "low", low: "low", medium: "medium", high: "high",
};

// ---------------------------------------------------------------------------
// OpenAI request → Anthropic request
// ---------------------------------------------------------------------------

function openaiPartsToAnthropic(content: OAIMessage["content"]): ABlockParam[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const blocks: ABlockParam[] = [];
  for (const part of content as unknown as Array<Record<string, unknown>>) {
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "refusal" && typeof part.refusal === "string") {
      blocks.push({ type: "text", text: part.refusal });
    } else if (part.type === "image_url") {
      const url = (part.image_url as { url?: string } | undefined)?.url ?? "";
      const data = parseDataUrl(url);
      if (data) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: data.mediaType as Anthropic.Base64ImageSource["media_type"], data: data.data },
        });
      } else if (url) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    } else if (part.type === "file") {
      const file = part.file as { file_data?: string } | undefined;
      const data = file?.file_data ? parseDataUrl(file.file_data) : null;
      if (data?.mediaType === "application/pdf") {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.data } });
      } else {
        throw new GatewayRequestError("Only base64 PDF files are supported in 'file' content parts.");
      }
    } else {
      throw new GatewayRequestError(`Unsupported content part type '${String(part.type)}'.`);
    }
  }
  return blocks;
}

/** Appends to `out`, merging into the previous message when the role repeats. */
function pushMessage(out: AMessageParam[], role: "user" | "assistant", blocks: ABlockParam[]) {
  if (!blocks.length) return;
  const last = out[out.length - 1];
  if (last && last.role === role) {
    const prev: ABlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    // Tool results must lead their user message, so keep them in front when merging.
    last.content = role === "user"
      ? [...prev.filter((b) => b.type === "tool_result"), ...blocks.filter((b) => b.type === "tool_result"),
        ...prev.filter((b) => b.type !== "tool_result"), ...blocks.filter((b) => b.type !== "tool_result")]
      : [...prev, ...blocks];
    return;
  }
  out.push({ role, content: blocks });
}

export function openaiRequestToAnthropic(req: OAIRequest, model: string): Anthropic.MessageCreateParams {
  if (req.n != null && req.n > 1) throw new GatewayRequestError("n > 1 is not supported.");

  const system: string[] = [];
  const messages: AMessageParam[] = [];

  for (const msg of req.messages ?? []) {
    switch (msg.role) {
      case "system":
      case "developer": {
        const text = openaiText(msg.content);
        if (text) system.push(text);
        break;
      }
      case "user":
        pushMessage(messages, "user", openaiPartsToAnthropic(msg.content));
        break;
      case "assistant": {
        const blocks = openaiPartsToAnthropic(msg.content ?? null);
        for (const call of msg.tool_calls ?? []) {
          if (call.type !== "function") continue;
          blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: safeJsonParse(call.function.arguments) });
        }
        if (msg.function_call) {
          blocks.push({ type: "tool_use", id: newId("call_"), name: msg.function_call.name, input: safeJsonParse(msg.function_call.arguments) });
        }
        pushMessage(messages, "assistant", blocks);
        break;
      }
      case "tool":
        pushMessage(messages, "user", [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: openaiText(msg.content) }]);
        break;
      case "function":
        throw new GatewayRequestError("Legacy 'function' role messages are not supported; use 'tool'.");
    }
  }

  if (!messages.length) throw new GatewayRequestError("messages must contain at least one user message.");

  const out: Anthropic.MessageCreateParams = {
    model,
    messages,
    // Current Claude models always think, and thinking counts against max_tokens — a small
    // OpenAI-style limit would be spent before the answer starts. See anthropic-reply.ts.
    max_tokens: Math.max(req.max_completion_tokens ?? req.max_tokens ?? 0, MIN_ASSISTANT_MAX_TOKENS),
  };
  if (system.length) out.system = system.join("\n\n");

  const stop = typeof req.stop === "string" ? [req.stop] : req.stop;
  if (stop?.length) out.stop_sequences = stop;
  // temperature / top_p are deliberately dropped: current Claude models reject sampling
  // parameters with a 400, and OpenAI clients send them by default.

  const effort = req.reasoning_effort ? OPENAI_EFFORT[req.reasoning_effort] : undefined;
  if (effort && modelSupportsEffort(model)) out.output_config = { effort };

  if (req.response_format?.type === "json_object" || req.response_format?.type === "json_schema") {
    const hint = req.response_format.type === "json_schema"
      ? `Respond with only a JSON value matching this schema:\n${JSON.stringify(req.response_format.json_schema.schema ?? {})}`
      : "Respond with only a valid JSON object.";
    out.system = out.system ? `${out.system}\n\n${hint}` : hint;
  }

  const tools = (req.tools ?? []).filter((t): t is OpenAI.Chat.ChatCompletionFunctionTool => t.type === "function");
  if (tools.length && req.tool_choice !== "none") {
    out.tools = tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: (t.function.parameters as Anthropic.Tool.InputSchema) ?? { type: "object", properties: {} },
    }));
    // "required" / a named function would map to tool_choice any / tool, which current
    // Claude models reject with a 400. auto plus the tool list is the closest that works.
    out.tool_choice = { type: "auto", ...(req.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}) };
  }

  return (req.stream ? { ...out, stream: true } : out) as Anthropic.MessageCreateParams;
}

// ---------------------------------------------------------------------------
// Anthropic request → OpenAI request
// ---------------------------------------------------------------------------

function anthropicSystemText(system: Anthropic.MessageCreateParams["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

function toolResultText(content: Anthropic.ToolResultBlockParam["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : `[${b.type} omitted]`)).join("\n");
}

export function anthropicRequestToOpenAI(req: Anthropic.MessageCreateParams, model: string): OAIRequest {
  const messages: OAIMessage[] = [];
  const system = anthropicSystemText(req.system);
  if (system) messages.push({ role: "system", content: system });

  for (const msg of req.messages) {
    const role = msg.role as string;
    if (role === "system") {
      const text = typeof msg.content === "string" ? msg.content : (msg.content as ABlockParam[]).map((b) => (b.type === "text" ? b.text : "")).join("");
      if (text) messages.push({ role: "system", content: text });
      continue;
    }
    const blocks: ABlockParam[] = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;

    if (msg.role === "assistant") {
      const text = blocks.filter((b): b is Anthropic.TextBlockParam => b.type === "text").map((b) => b.text).join("");
      const toolCalls = blocks
        .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !toolCalls.length) continue;
      messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }

    // user: tool results become `tool` messages (which must come first), the rest one user message.
    for (const b of blocks) {
      if (b.type === "tool_result") {
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultText(b.content) || (b.is_error ? "Error" : "") });
      }
    }
    const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
    for (const b of blocks) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") {
        const src = b.source;
        if (src.type === "base64") parts.push({ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } });
        else if (src.type === "url") parts.push({ type: "image_url", image_url: { url: src.url } });
      } else if (b.type === "document" && b.source.type === "base64" && b.source.media_type === "application/pdf") {
        parts.push({ type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${b.source.data}` } });
      } else if (b.type === "document" && b.source.type === "text") {
        parts.push({ type: "text", text: b.source.data });
      } else if (b.type !== "tool_result") {
        throw new GatewayRequestError(`Content block type '${b.type}' can't be sent to an OpenAI provider.`);
      }
    }
    if (parts.length) {
      messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n") : parts });
    }
  }

  const out: OpenAI.Chat.ChatCompletionCreateParams = {
    model,
    messages,
    max_completion_tokens: req.max_tokens,
  };
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;

  const tools = (req.tools ?? []).filter((t): t is Anthropic.Tool => "input_schema" in t);
  if (tools.length) {
    out.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema as Record<string, unknown> },
    }));
    const choice = req.tool_choice;
    if (choice?.type === "any") out.tool_choice = "required";
    else if (choice?.type === "tool") out.tool_choice = { type: "function", function: { name: choice.name } };
    else if (choice?.type === "none") out.tool_choice = "none";
    if (choice && "disable_parallel_tool_use" in choice && choice.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }

  return (req.stream ? { ...out, stream: true, stream_options: { include_usage: true } } : out) as OAIRequest;
}

// ---------------------------------------------------------------------------
// Responses (non-streaming)
// ---------------------------------------------------------------------------

export function anthropicMessageToOpenAI(msg: Anthropic.Message, model: string = msg.model): OAICompletion {
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const toolCalls = msg.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const u = msg.usage;
  const cached = u.cache_read_input_tokens ?? 0;
  const promptTokens = u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0);
  return {
    id: msg.id.startsWith("chatcmpl-") ? msg.id : `chatcmpl-${msg.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || (toolCalls.length ? null : ""),
        refusal: null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: anthropicStopToOpenAI(msg.stop_reason) ?? "stop",
      logprobs: null,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: u.output_tokens,
      total_tokens: promptTokens + u.output_tokens,
      ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    },
  };
}

export function openaiCompletionToAnthropic(c: OAICompletion, model: string = c.model): Anthropic.Message {
  const choice = c.choices[0];
  const content: Anthropic.ContentBlock[] = [];
  const text = choice?.message.content ?? choice?.message.refusal ?? "";
  if (text) content.push({ type: "text", text, citations: null } as Anthropic.TextBlock);
  for (const call of choice?.message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input: safeJsonParse(call.function.arguments) } as Anthropic.ToolUseBlock);
  }
  const cached = c.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    id: newId("msg_"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: openaiFinishToAnthropic(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Math.max((c.usage?.prompt_tokens ?? 0) - cached, 0),
      output_tokens: c.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as Anthropic.Message;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Rebuilds a complete Message from Anthropic stream events (CLI output → non-streaming reply). */
export function accumulateAnthropicEvents(events: AEvent[], fallbackModel = ""): Anthropic.Message {
  let message: Anthropic.Message | null = null;
  const blocks: Array<Record<string, unknown>> = [];
  const json: string[] = [];

  for (const ev of events) {
    switch (ev.type) {
      case "message_start":
        message = { ...ev.message, content: [] };
        break;
      case "content_block_start":
        blocks[ev.index] = { ...ev.content_block };
        json[ev.index] = "";
        break;
      case "content_block_delta": {
        const b = blocks[ev.index];
        if (!b) break;
        const d = ev.delta;
        if (d.type === "text_delta") b.text = `${(b.text as string) ?? ""}${d.text}`;
        else if (d.type === "input_json_delta") json[ev.index] += d.partial_json;
        else if (d.type === "thinking_delta") b.thinking = `${(b.thinking as string) ?? ""}${d.thinking}`;
        else if (d.type === "signature_delta") b.signature = d.signature;
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b?.type === "tool_use" && json[ev.index]) b.input = safeJsonParse(json[ev.index]);
        break;
      }
      case "message_delta":
        if (message) {
          message.stop_reason = ev.delta.stop_reason ?? message.stop_reason;
          message.stop_sequence = ev.delta.stop_sequence ?? message.stop_sequence;
          message.usage = { ...message.usage, output_tokens: ev.usage.output_tokens ?? message.usage.output_tokens };
          if (ev.usage.input_tokens != null) message.usage.input_tokens = ev.usage.input_tokens;
        }
        break;
    }
  }

  const base: Anthropic.Message = message ?? textToAnthropicMessage("", fallbackModel);
  return { ...base, content: blocks.filter(Boolean) as unknown as Anthropic.ContentBlock[] };
}

export function textToAnthropicMessage(
  text: string,
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } = {},
): Anthropic.Message {
  return {
    id: newId("msg_"),
    type: "message",
    role: "assistant",
    model,
    content: text ? [{ type: "text", text, citations: null } as Anthropic.TextBlock] : [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as Anthropic.Message;
}

/** The full event sequence for a complete message — for backends that can't stream (Codex). */
export function anthropicMessageToEvents(msg: Anthropic.Message): AEvent[] {
  const events: AEvent[] = [
    { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 0 } } } as AEvent,
  ];
  msg.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { ...block, text: "" } } as AEvent);
      if (block.text) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } as AEvent);
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } } as AEvent);
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } } as AEvent);
    } else {
      events.push({ type: "content_block_start", index, content_block: block } as AEvent);
    }
    events.push({ type: "content_block_stop", index } as AEvent);
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason, stop_sequence: msg.stop_sequence },
    usage: { output_tokens: msg.usage.output_tokens },
  } as AEvent);
  events.push({ type: "message_stop" } as AEvent);
  return events;
}

/**
 * Stateful Anthropic-event → OpenAI-chunk translator. Feed it every event; it returns the
 * chunks to emit (possibly none). Thinking blocks are dropped — OpenAI clients have no slot
 * for them. Call `finish()` after the last event for the trailing usage chunk.
 */
export class AnthropicToOpenAIStream {
  private id = newId("chatcmpl-");
  private created = Math.floor(Date.now() / 1000);
  private toolIndexByBlock = new Map<number, number>();
  private nextToolIndex = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private finishReason: FinishReason = null;
  private sentFinal = false;

  constructor(private model: string, private includeUsage = false) {}

  private chunk(delta: ChunkDelta, finish: FinishReason = null): OAIChunk {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    };
  }

  push(ev: AEvent): OAIChunk[] {
    switch (ev.type) {
      case "message_start": {
        // Report the model that actually ran (the CLI resolves aliases; the API returns its id).
        if (ev.message.model) this.model = ev.message.model;
        const u = ev.message.usage;
        this.promptTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        return [this.chunk({ role: "assistant", content: "" })];
      }
      case "content_block_start": {
        const b = ev.content_block;
        if (b.type === "tool_use") {
          const index = this.nextToolIndex++;
          this.toolIndexByBlock.set(ev.index, index);
          return [this.chunk({ tool_calls: [{ index, id: b.id, type: "function", function: { name: b.name, arguments: "" } }] })];
        }
        if (b.type === "text" && b.text) return [this.chunk({ content: b.text })];
        return [];
      }
      case "content_block_delta": {
        const d = ev.delta;
        if (d.type === "text_delta") return d.text ? [this.chunk({ content: d.text })] : [];
        if (d.type === "input_json_delta") {
          const index = this.toolIndexByBlock.get(ev.index);
          if (index == null || !d.partial_json) return [];
          return [this.chunk({ tool_calls: [{ index, function: { arguments: d.partial_json } }] })];
        }
        return [];
      }
      case "message_delta":
        this.finishReason = anthropicStopToOpenAI(ev.delta.stop_reason);
        this.completionTokens = ev.usage.output_tokens ?? this.completionTokens;
        return [];
      case "message_stop":
        this.sentFinal = true;
        return [this.chunk({}, this.finishReason ?? "stop")];
      default:
        return [];
    }
  }

  finish(): OAIChunk[] {
    const out: OAIChunk[] = [];
    if (!this.sentFinal) out.push(this.chunk({}, this.finishReason ?? "stop"));
    if (this.includeUsage) {
      out.push({
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [],
        usage: {
          prompt_tokens: this.promptTokens,
          completion_tokens: this.completionTokens,
          total_tokens: this.promptTokens + this.completionTokens,
        },
      });
    }
    return out;
  }
}

/**
 * Stateful OpenAI-chunk → Anthropic-event translator (OpenAI provider answering an
 * Anthropic-format streaming request). Call `finish()` once the upstream stream ends.
 */
export class OpenAIToAnthropicStream {
  private started = false;
  private openBlock: { index: number; kind: "text" | "tool"; toolIndex?: number } | null = null;
  private nextBlock = 0;
  private stopReason: Anthropic.StopReason = "end_turn";
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(private model: string) {}

  private start(): AEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{
      type: "message_start",
      message: { ...textToAnthropicMessage("", this.model), stop_reason: null },
    } as AEvent];
  }

  private closeBlock(): AEvent[] {
    if (!this.openBlock) return [];
    const ev = { type: "content_block_stop", index: this.openBlock.index } as AEvent;
    this.openBlock = null;
    return [ev];
  }

  push(chunk: OAIChunk): AEvent[] {
    const out = this.start();
    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};

    const text = delta.content ?? delta.refusal;
    if (text) {
      if (this.openBlock?.kind !== "text") {
        out.push(...this.closeBlock());
        this.openBlock = { index: this.nextBlock++, kind: "text" };
        out.push({ type: "content_block_start", index: this.openBlock.index, content_block: { type: "text", text: "", citations: null } } as AEvent);
      }
      out.push({ type: "content_block_delta", index: this.openBlock.index, delta: { type: "text_delta", text } } as AEvent);
    }

    for (const call of delta.tool_calls ?? []) {
      if (this.openBlock?.kind !== "tool" || this.openBlock.toolIndex !== call.index) {
        out.push(...this.closeBlock());
        this.openBlock = { index: this.nextBlock++, kind: "tool", toolIndex: call.index };
        out.push({
          type: "content_block_start",
          index: this.openBlock.index,
          content_block: { type: "tool_use", id: call.id ?? newId("toolu_"), name: call.function?.name ?? "", input: {} },
        } as AEvent);
      }
      const args = call.function?.arguments;
      if (args) out.push({ type: "content_block_delta", index: this.openBlock.index, delta: { type: "input_json_delta", partial_json: args } } as AEvent);
    }

    if (choice.finish_reason) this.stopReason = openaiFinishToAnthropic(choice.finish_reason);
    return out;
  }

  finish(): AEvent[] {
    return [
      ...this.start(),
      ...this.closeBlock(),
      {
        type: "message_delta",
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
      } as AEvent,
      { type: "message_stop" } as AEvent,
    ];
  }
}

// ---------------------------------------------------------------------------
// Claude CLI multi-turn stream → one message
// ---------------------------------------------------------------------------

/**
 * Folds the Claude CLI's raw stream events into the events of a single message.
 *
 * When the CLI may use its own tools (web search/fetch, MCP servers), one gateway request is
 * several API calls in a row: a message that ends in `tool_use`, the CLI runs the tool, another
 * message, and so on. The client asked one question, so it gets one message: the first
 * `message_start`, every text/thinking block renumbered into one sequence, the CLI's internal
 * `tool_use` blocks left out (the client didn't ask for them and can't answer them), and one
 * closing `message_delta`/`message_stop` carrying the last turn's stop reason and the summed
 * output tokens — emitted by finish(), once the CLI is done.
 */
export class CliTurnMerger {
  private started = false;
  private nextIndex = 0;
  /** Upstream block index → our index, or null for a hidden block — reset per upstream message. */
  private indexMap = new Map<number, number | null>();
  private outputTokens = 0;
  private lastDelta: Anthropic.RawMessageDeltaEvent | null = null;
  private stopped = false;

  push(ev: AEvent): AEvent[] {
    switch (ev.type) {
      case "message_start":
        this.indexMap.clear();
        if (this.started) return [];
        this.started = true;
        return [ev];
      case "content_block_start": {
        const type = ev.content_block.type;
        if (type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use" as string) {
          this.indexMap.set(ev.index, null);
          return [];
        }
        const index = this.nextIndex++;
        this.indexMap.set(ev.index, index);
        return [{ ...ev, index }];
      }
      case "content_block_delta":
      case "content_block_stop": {
        const index = this.indexMap.get(ev.index);
        return index == null ? [] : [{ ...ev, index }];
      }
      case "message_delta":
        this.outputTokens += ev.usage?.output_tokens ?? 0;
        this.lastDelta = ev;
        return [];
      case "message_stop":
        return [];
      default:
        return [ev];
    }
  }

  finish(): AEvent[] {
    if (!this.started || this.stopped) return [];
    this.stopped = true;
    const delta: Anthropic.RawMessageDeltaEvent = this.lastDelta
      ? { ...this.lastDelta, usage: { ...this.lastDelta.usage, output_tokens: this.outputTokens } }
      : { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: this.outputTokens } } as Anthropic.RawMessageDeltaEvent;
    // A last turn that still ended in tool_use was the CLI being cut off mid-loop; to the
    // client the hidden tool calls don't exist, so it's a plain end of turn.
    if (delta.delta.stop_reason === "tool_use") delta.delta = { ...delta.delta, stop_reason: "end_turn" };
    return [delta, { type: "message_stop" } as AEvent];
  }
}
