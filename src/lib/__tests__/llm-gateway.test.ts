import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import {
  AnthropicToOpenAIStream,
  GatewayRequestError,
  OpenAIToAnthropicStream,
  accumulateAnthropicEvents,
  anthropicMessageToEvents,
  anthropicMessageToOpenAI,
  anthropicRequestToOpenAI,
  openaiCompletionToAnthropic,
  openaiRequestToAnthropic,
  textToAnthropicMessage,
  CliTurnMerger,
} from "../llm-gateway/convert";
import { applyCliToolCalls, buildCliPrompt, parseCliToolCalls, resolveGatewayModel } from "../llm-gateway/routing";
import { MIN_ASSISTANT_MAX_TOKENS } from "../anthropic-reply";

type AEvent = Anthropic.RawMessageStreamEvent;

describe("resolveGatewayModel", () => {
  const claude = { type: "cli", model: "claude-sonnet-5" };
  it("uses the provider's model for default aliases", () => {
    assert.equal(resolveGatewayModel("default", claude), "claude-sonnet-5");
    assert.equal(resolveGatewayModel("", claude), "claude-sonnet-5");
    assert.equal(resolveGatewayModel(undefined, { type: "cli", model: null }), undefined);
  });
  it("honours a model from the provider's own vendor", () => {
    assert.equal(resolveGatewayModel("claude-haiku-4-5", claude), "claude-haiku-4-5");
    assert.equal(resolveGatewayModel("gpt-5.5", { type: "codex-cli", model: null }), "gpt-5.5");
  });
  it("swaps a model from the other vendor for the provider's", () => {
    assert.equal(resolveGatewayModel("gpt-4o", claude), "claude-sonnet-5");
    assert.equal(resolveGatewayModel("claude-opus-5-5", { type: "openai", model: "gpt-4.1" }), "gpt-4.1");
  });
  it("only passes unknown ids where custom models are plausible", () => {
    assert.equal(resolveGatewayModel("llama3", { type: "openai", model: null }), "llama3");
    assert.equal(resolveGatewayModel("my-alias", { type: "api", model: null, baseUrl: "https://gw.example" }), "my-alias");
    assert.equal(resolveGatewayModel("llama3", claude), "claude-sonnet-5");
  });
});

describe("openaiRequestToAnthropic", () => {
  it("moves system/developer messages to system and drops sampling params", () => {
    const out = openaiRequestToAnthropic({
      model: "gpt-4o",
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 50,
      messages: [
        { role: "system", content: "Be terse." },
        { role: "developer", content: "Use British spelling." },
        { role: "user", content: "hi" },
      ],
    }, "claude-opus-5-5");
    assert.equal(out.system, "Be terse.\n\nUse British spelling.");
    assert.deepEqual(out.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    assert.equal(out.max_tokens, MIN_ASSISTANT_MAX_TOKENS);
    assert.equal("temperature" in out, false);
    assert.equal("top_p" in out, false);
  });

  it("maps tool calls and tool results, merging results into one user turn", () => {
    const out = openaiRequestToAnthropic({
      model: "x",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [
          { id: "c1", type: "function", function: { name: "w", arguments: '{"city":"Oslo"}' } },
          { id: "c2", type: "function", function: { name: "w", arguments: '{"city":"Rome"}' } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "cold" },
        { role: "tool", tool_call_id: "c2", content: "warm" },
      ],
      tools: [{ type: "function", function: { name: "w", parameters: { type: "object" } } }],
      tool_choice: "required",
    }, "claude-opus-5-5");
    assert.equal(out.messages.length, 3);
    const assistant = out.messages[1].content as Anthropic.ToolUseBlockParam[];
    assert.deepEqual(assistant.map((b) => [b.type, b.id, b.input]), [["tool_use", "c1", { city: "Oslo" }], ["tool_use", "c2", { city: "Rome" }]]);
    const results = out.messages[2].content as Anthropic.ToolResultBlockParam[];
    assert.deepEqual(results.map((b) => [b.type, b.tool_use_id, b.content]), [["tool_result", "c1", "cold"], ["tool_result", "c2", "warm"]]);
    assert.equal(out.tools?.[0].name, "w");
    // Forced tool choice 400s on current Claude models.
    assert.deepEqual(out.tool_choice, { type: "auto" });
  });

  it("converts data-URL and remote images", () => {
    const out = openaiRequestToAnthropic({
      model: "x",
      messages: [{ role: "user", content: [
        { type: "text", text: "what?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://e.x/a.jpg" } },
      ] }],
    }, "m");
    const blocks = out.messages[0].content as Anthropic.ContentBlockParam[];
    assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    assert.deepEqual(blocks[2], { type: "image", source: { type: "url", url: "https://e.x/a.jpg" } });
  });

  it("keeps the stream flag and rejects n > 1", () => {
    assert.equal(openaiRequestToAnthropic({ model: "x", stream: true, messages: [{ role: "user", content: "a" }] }, "m").stream, true);
    assert.throws(() => openaiRequestToAnthropic({ model: "x", n: 2, messages: [{ role: "user", content: "a" }] }, "m"), GatewayRequestError);
  });
});

describe("anthropicRequestToOpenAI", () => {
  it("maps system, tool use and tool results", () => {
    const out = anthropicRequestToOpenAI({
      model: "claude-x",
      max_tokens: 100,
      system: [{ type: "text", text: "sys" }],
      stream: true,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }, { type: "text", text: "next" }] },
      ],
      tools: [{ name: "f", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    }, "gpt-4.1");
    assert.deepEqual(out.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
    const assistant = out.messages[2] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    assert.equal(assistant.content, "ok");
    assert.equal(assistant.tool_calls?.[0].id, "t1");
    assert.equal(out.tool_choice, "required");
    assert.equal(out.max_completion_tokens, 100);
    assert.deepEqual((out as OpenAI.Chat.ChatCompletionCreateParamsStreaming).stream_options, { include_usage: true });
  });
});

describe("non-streaming responses", () => {
  it("Anthropic message → OpenAI completion skips thinking and maps usage", () => {
    const msg = {
      ...textToAnthropicMessage("", "claude-opus-5-5", { input_tokens: 10, output_tokens: 5 }),
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "hello", citations: null },
        { type: "tool_use", id: "t", name: "f", input: { x: 1 } },
      ],
      stop_reason: "tool_use",
    } as unknown as Anthropic.Message;
    msg.usage.cache_read_input_tokens = 20;
    const c = anthropicMessageToOpenAI(msg);
    assert.equal(c.choices[0].message.content, "hello");
    assert.equal(c.choices[0].message.tool_calls?.[0].type, "function");
    assert.equal(c.choices[0].finish_reason, "tool_calls");
    assert.deepEqual([c.usage?.prompt_tokens, c.usage?.completion_tokens, c.usage?.prompt_tokens_details?.cached_tokens], [30, 5, 20]);
  });

  it("OpenAI completion → Anthropic message", () => {
    const m = openaiCompletionToAnthropic({
      id: "x", object: "chat.completion", created: 0, model: "gpt-4.1",
      choices: [{ index: 0, finish_reason: "length", logprobs: null, message: { role: "assistant", content: "hi", refusal: null } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    assert.equal(m.stop_reason, "max_tokens");
    assert.deepEqual(m.content.map((b) => b.type), ["text"]);
    assert.deepEqual([m.usage.input_tokens, m.usage.output_tokens], [7, 3]);
  });
});

describe("streaming", () => {
  const sample = {
    ...textToAnthropicMessage("Hello world", "claude-opus-5-5", { input_tokens: 4, output_tokens: 2 }),
  };

  it("message → events → message round-trips", () => {
    const back = accumulateAnthropicEvents(anthropicMessageToEvents(sample));
    assert.deepEqual(back.content, sample.content);
    assert.equal(back.stop_reason, "end_turn");
    assert.equal(back.usage.output_tokens, 2);
  });

  it("Anthropic events → OpenAI chunks, thinking dropped, usage on request", () => {
    const events: AEvent[] = [
      { type: "message_start", message: { ...sample, content: [], stop_reason: null } } as AEvent,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } as AEvent,
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } as AEvent,
      { type: "content_block_stop", index: 0 } as AEvent,
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "", citations: null } } as AEvent,
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } } as AEvent,
      { type: "content_block_stop", index: 1 } as AEvent,
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t", name: "f", input: {} } } as AEvent,
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a":' } } as AEvent,
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "1}" } } as AEvent,
      { type: "content_block_stop", index: 2 } as AEvent,
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } } as AEvent,
      { type: "message_stop" } as AEvent,
    ];
    const t = new AnthropicToOpenAIStream("m", true);
    const chunks = [...events.flatMap((e) => t.push(e)), ...t.finish()];
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
    assert.equal(text, "Hi");
    // The model that ran, from message_start — not the placeholder the translator was built with.
    assert.equal(chunks[0].model, "claude-opus-5-5");
    const args = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).map((tc) => tc.function?.arguments ?? "").join("");
    assert.equal(args, '{"a":1}');
    assert.equal(chunks.at(-2)?.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(chunks.at(-1)?.choices, []);
    assert.equal(chunks.at(-1)?.usage?.completion_tokens, 9);
  });

  it("OpenAI chunks → Anthropic events accumulate into the right message", () => {
    const base = { id: "c", object: "chat.completion.chunk" as const, created: 0, model: "gpt" };
    const chunks: OpenAI.Chat.ChatCompletionChunk[] = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "f", arguments: '{"q"' } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] }, finish_reason: "tool_calls" }] },
      { ...base, choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
    ];
    const t = new OpenAIToAnthropicStream("gpt");
    const events = [...chunks.flatMap((c) => t.push(c)), ...t.finish()];
    assert.equal(events[0].type, "message_start");
    assert.equal(events.at(-1)?.type, "message_stop");
    const msg = accumulateAnthropicEvents(events);
    assert.deepEqual(msg.content.map((b) => b.type), ["text", "tool_use"]);
    assert.equal((msg.content[0] as Anthropic.TextBlock).text, "Hello");
    assert.deepEqual((msg.content[1] as Anthropic.ToolUseBlock).input, { q: "x" });
    assert.equal(msg.stop_reason, "tool_use");
    assert.deepEqual([msg.usage.input_tokens, msg.usage.output_tokens], [3, 4]);
  });
});

describe("buildCliPrompt", () => {
  it("passes a single user turn through verbatim", () => {
    const p = buildCliPrompt({ model: "m", max_tokens: 1, system: "S", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(p, { system: "S", prompt: "hi", attachments: [], builtinTools: [], clientToolNames: [] });
  });
  it("uses a neutral system prompt when none is given", () => {
    assert.equal(buildCliPrompt({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }).system, "You are a helpful assistant.");
  });
  it("turns history into a transcript ending on the latest user turn", () => {
    const p = buildCliPrompt({ model: "m", max_tokens: 1, messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
      { role: "user", content: "c" },
    ] });
    assert.match(p.prompt, /<user>\na\n<\/user>\n\n<assistant>\nb\n<\/assistant>/);
    assert.ok(p.prompt.endsWith("c"));
  });
  it("describes client tools in the system prompt and honours tool_choice", () => {
    const tools = [{ name: "get_weather", description: "Weather for a city", input_schema: { type: "object" as const, properties: { city: { type: "string" } } } }];
    const p = buildCliPrompt({ model: "m", max_tokens: 1, system: "S", messages: [{ role: "user", content: "hi" }], tools });
    assert.ok(p.system.startsWith("S\n\n# Tools"));
    assert.match(p.system, /<tool name="get_weather">\nDescription: Weather for a city/);
    assert.match(p.system, /"city":\{"type":"string"\}/);
    assert.equal(p.prompt, "hi");
    const forced = buildCliPrompt({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }], tools, tool_choice: { type: "tool", name: "get_weather" } });
    assert.match(forced.system, /must call the tool "get_weather"/);
    const none = buildCliPrompt({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }], tools, tool_choice: { type: "none" } });
    assert.doesNotMatch(none.system, /# Tools/);
  });
  it("replays earlier tool calls and results in the transcript", () => {
    const p = buildCliPrompt({ model: "m", max_tokens: 1, tools: [{ name: "f", input_schema: { type: "object" } }], messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "toolu_1", name: "f", input: { x: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "42" }] }] },
    ] });
    assert.match(p.prompt, /<tool_call>\n\{"name":"f","input":\{"x":1\}\}\n<\/tool_call>/);
    assert.ok(p.prompt.endsWith('<tool_result id="toolu_1">\n42\n</tool_result>'));
  });
  it("maps web search/fetch server tools onto the CLI's built-in tools", () => {
    const p = buildCliPrompt({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "news?" }], tools: [
      { type: "web_search_20250305", name: "web_search", allowed_domains: ["bbc.co.uk"], max_uses: 3 },
      { type: "web_fetch_20250910", name: "web_fetch" } as unknown as Anthropic.ToolUnion,
    ] });
    assert.deepEqual(p.builtinTools, ["WebSearch", "WebFetch"]);
    assert.deepEqual(p.clientToolNames, []);
    assert.match(p.system, /Only use web search with these domains: bbc\.co\.uk/);
    assert.match(p.system, /at most 3 times/);
  });
  it("sends images and PDFs as attachments referenced from the prompt", () => {
    const img = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAA" }, cache_control: { type: "ephemeral" as const } };
    const p = buildCliPrompt({ model: "m", max_tokens: 1, messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, img] }] });
    assert.equal(p.prompt, "what is this?\n[attachment 1]");
    assert.deepEqual(p.attachments, [{ type: "image", source: img.source }]);
  });
  it("refuses other server tools and a trailing assistant turn", () => {
    assert.throws(() => buildCliPrompt({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "a" }], tools: [{ type: "code_execution_20250825", name: "code_execution" } as unknown as Anthropic.ToolUnion] }), GatewayRequestError);
    assert.throws(() => buildCliPrompt({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }), GatewayRequestError);
  });
});

describe("parseCliToolCalls", () => {
  it("turns <tool_call> blocks into tool_use blocks, keeping surrounding text", () => {
    const r = parseCliToolCalls('Let me look.\n<tool_call>\n{"name": "f", "input": {"q": "x"}}\n</tool_call>\n<tool_call>{"name":"g","input":{}}</tool_call>', ["f", "g"]);
    assert.equal(r.hasToolUse, true);
    assert.deepEqual(r.content.map((b) => b.type), ["text", "tool_use", "tool_use"]);
    assert.equal((r.content[0] as { text: string }).text, "Let me look.");
    const call = r.content[1] as { id: string; name: string; input: unknown };
    assert.match(call.id, /^toolu_/);
    assert.deepEqual([call.name, call.input], ["f", { q: "x" }]);
  });
  it("keeps unknown tools, bad JSON and plain answers as text", () => {
    assert.equal(parseCliToolCalls("<tool_call>{\"name\":\"nope\",\"input\":{}}</tool_call>", ["f"]).hasToolUse, false);
    assert.equal(parseCliToolCalls("<tool_call>{oops</tool_call>", ["f"]).hasToolUse, false);
    assert.deepEqual(parseCliToolCalls("just text", ["f"]).content, [{ type: "text", text: "just text", citations: null }]);
  });
  it("strips code fences and drops an imagined tool result", () => {
    const r = parseCliToolCalls('```xml\n<tool_call>{"name":"f","input":{}}</tool_call>\n```\n<tool_result>made up</tool_result>', ["f"]);
    assert.deepEqual(r.content.map((b) => b.type), ["tool_use"]);
  });
  it("sets stop_reason tool_use on the rewritten message", () => {
    const msg = applyCliToolCalls(textToAnthropicMessage('<tool_call>{"name":"f","input":{"a":1}}</tool_call>', "m"), ["f"]);
    assert.equal(msg.stop_reason, "tool_use");
    const oaiCall = anthropicMessageToOpenAI(msg).choices[0].message.tool_calls?.[0];
    assert.equal(oaiCall?.type === "function" ? oaiCall.function.arguments : undefined, '{"a":1}');
    assert.equal(applyCliToolCalls(textToAnthropicMessage("hi", "m"), ["f"]).stop_reason, "end_turn");
  });
});

describe("CliTurnMerger", () => {
  it("folds the CLI's tool-use turns into one message without the internal tool calls", () => {
    const m = new CliTurnMerger();
    const start = (id: string) => ({ type: "message_start", message: { ...textToAnthropicMessage("", "m"), id } }) as AEvent;
    const raw: AEvent[] = [
      start("a"),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } } as AEvent,
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Searching. " } } as AEvent,
      { type: "content_block_stop", index: 0 } as AEvent,
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "WebSearch", input: {} } } as AEvent,
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } } as AEvent,
      { type: "content_block_stop", index: 1 } as AEvent,
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } } as AEvent,
      { type: "message_stop" } as AEvent,
      start("b"),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } } as AEvent,
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found it." } } as AEvent,
      { type: "content_block_stop", index: 0 } as AEvent,
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } } as AEvent,
      { type: "message_stop" } as AEvent,
    ];
    const out = [...raw.flatMap((e) => m.push(e)), ...m.finish()];
    assert.equal(out.filter((e) => e.type === "message_start").length, 1);
    assert.equal(out.filter((e) => e.type === "message_stop").length, 1);
    const msg = accumulateAnthropicEvents(out);
    assert.deepEqual(msg.content.map((b) => (b as { text: string }).text), ["Searching. ", "Found it."]);
    assert.equal(msg.stop_reason, "end_turn");
    assert.equal(msg.usage.output_tokens, 12);
  });
});
