// Content of the /docs/llm-gateway page, shared with the MCP get_docs tool.
// Keep it in step with the gateway itself: src/lib/llm-gateway/{backends,routing,convert}.ts.
import { absoluteLinks, mdCode, mdDoc, mdList, mdTable } from "./markdown";

export const LLM_GATEWAY_KEY_PLACEHOLDER = "tm_live_YOUR_KEY";

/** Base URLs for the gateway (src/app/api/llm/v1/*) on a given origin. */
export function llmGatewayUrls(origin: string) {
  const base = origin.replace(/\/+$/, "");
  return { openai: `${base}/api/llm/v1`, anthropic: `${base}/api/llm` };
}

export interface DocSnippet {
  id: string;
  label: string;
  lang: string;
  code: string;
}

export function llmGatewaySnippets(origin: string, key = LLM_GATEWAY_KEY_PLACEHOLDER): DocSnippet[] {
  const { openai, anthropic } = llmGatewayUrls(origin);
  return [
    {
      id: "openai-py",
      label: "OpenAI · Python",
      lang: "python",
      code: `from openai import OpenAI

client = OpenAI(base_url="${openai}", api_key="${key}")

reply = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Summarise the plot of Hamlet in one line."}],
)
print(reply.choices[0].message.content)`,
    },
    {
      id: "openai-ts",
      label: "OpenAI · TypeScript",
      lang: "ts",
      code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${openai}", apiKey: "${key}" });

const stream = await client.chat.completions.create({
  model: "default",
  stream: true,
  messages: [{ role: "user", content: "Write a haiku about queues." }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");`,
    },
    {
      id: "anthropic-py",
      label: "Anthropic · Python",
      lang: "python",
      code: `import anthropic

client = anthropic.Anthropic(base_url="${anthropic}", api_key="${key}")

message = client.messages.create(
    model="default",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Summarise the plot of Hamlet in one line."}],
)
print(message.content[-1].text)`,
    },
    {
      id: "anthropic-ts",
      label: "Anthropic · TypeScript",
      lang: "ts",
      code: `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ baseURL: "${anthropic}", apiKey: "${key}" });

const stream = client.messages.stream({
  model: "default",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Write a haiku about queues." }],
});
stream.on("text", (text) => process.stdout.write(text));
await stream.finalMessage();`,
    },
    {
      id: "curl",
      label: "cURL",
      lang: "bash",
      code: `# OpenAI format
curl ${openai}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"default","messages":[{"role":"user","content":"Hello"}]}'

# Anthropic format
curl ${anthropic}/v1/messages \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"default","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'`,
    },
    {
      id: "env",
      label: "Environment variables",
      lang: "bash",
      code: `# Many tools and SDKs read these instead of taking a base URL in code.
export OPENAI_BASE_URL="${openai}"
export OPENAI_API_KEY="${key}"

export ANTHROPIC_BASE_URL="${anthropic}"
export ANTHROPIC_API_KEY="${key}"`,
    },
  ];
}

export const LLM_GATEWAY_DOC = {
  title: "OpenAI / Anthropic-compatible API",
  intro:
    "The Task Manager can stand in for the OpenAI or Anthropic API. Point any app, script or tool built for either " +
    "API at the base URL below and give it a Task Manager API key. Its requests then run on the AI provider chosen for " +
    "that key (your default provider unless you pick another), whichever vendor that is. A tool written for OpenAI can run on your Claude subscription, and the reverse, with no " +
    "code changes.",
  auth: "A `tm_live_…` key from [Settings → API](/settings/api), sent as `Authorization: Bearer …` or `x-api-key: …`.",

  setupKey:
    "Go to [Settings → API](/settings/api) and create a key named after the service that will use it. These are the " +
    "same keys the [REST API](/docs/api) uses. The key is shown once, so copy it straight away. Send it wherever the " +
    "service expects its OpenAI or Anthropic key. Both `Authorization: Bearer …` and `x-api-key: …` are accepted.",
  setupProvider:
    "Each key has a **Provider** setting, chosen when you create it and changeable later in the key list in " +
    "[Settings → API](/settings/api), just like a task's AI Provider. **Default provider** runs requests on the same " +
    "provider a new task would get: if the Smart Provider Picker is on, it chooses; otherwise your default connection " +
    "in [Settings → AI](/settings/ai) answers. **Smart Provider** always picks the best available connection on each " +
    "request. Picking **one connection** pins the key to it, so different services can run on different accounts. If " +
    "the chosen connection is disabled, deleted or rate-limited, the request falls back to the default chain and any " +
    "other enabled connection takes over. The client doesn't need to change.",
  setupClient: "Replace `tm_live_YOUR_KEY` with your key. The URLs already point at this deployment.",
  setupNotes: [
    "The OpenAI base URL ends in `/v1` and the Anthropic one doesn't, because the Anthropic SDKs add `/v1/messages` themselves.",
    "The client must be able to reach this server. Use HTTPS when it connects across a network, since the key travels in a header.",
  ],

  modelsIntro: "Clients keep sending the model name they were built for. The gateway decides whether to use it:",
  modelsHead: ["Model sent", "What runs"],
  models: [
    ["`default`", "The provider's configured model (also for `auto`, or no model at all)."],
    ["A model from the provider's vendor", "Used as sent, e.g. `claude-haiku-4-5` on a Claude provider or `gpt-5.5` on Codex."],
    ["A model from the other vendor", "Replaced by the provider's configured model, so an app hard-wired to `gpt-4o` still works on Claude."],
    ["An unrecognised name", "Used as sent on OpenAI-compatible connections and connections with a custom base URL (self-hosted models, gateway aliases). Otherwise the provider's model is used."],
  ],
  modelsOutro: "Where the provider reports it, the `model` field in each response names the model that actually ran.",

  providersIntro:
    "When the request format matches the provider's own API, it is passed straight through. Otherwise it is " +
    "translated, in both directions, including streaming.",
  providersHead: ["Provider type", "Streaming", "Tool calling", "Images / PDFs", "Notes"],
  providers: [
    ["Anthropic API / Claude PKI", "Yes", "Yes", "Yes", "Anthropic-format requests pass through unchanged, including `anthropic-beta` headers."],
    ["OpenAI-compatible", "Yes", "Yes", "Yes", "OpenAI-format requests pass through unchanged."],
    ["Claude Code (subscription)", "Yes, token by token (in one chunk when your own tools are sent)", "Yes, emulated, plus web search/fetch and MCP", "Yes", "Runs `claude -p`. See \"Subscription CLIs\" below."],
    ["Codex (subscription)", "Sent in one chunk at the end", "Yes, emulated, plus MCP", "No", "Runs `codex exec` read-only. No web search/fetch or images."],
  ],
  translationNotes: [
    "**OpenAI → Claude:** `temperature` and `top_p` are dropped, because current Claude models reject them. " +
      "`tool_choice: \"required\"` and a named function become `auto` for the same reason. `max_tokens` is raised to " +
      "at least 8,192, because Claude spends part of the limit thinking before it answers. `response_format` becomes a " +
      "JSON instruction in the system prompt, and `reasoning_effort` maps to effort. `n` greater than 1 isn't supported.",
    "**Claude → OpenAI clients:** thinking blocks are left out, because the OpenAI format has no place for them. " +
      "Cached input tokens are reported in `prompt_tokens_details.cached_tokens`.",
    "**Subscription CLIs:** a conversation with more than one turn is passed to the CLI as a transcript. It must end " +
      "with a user message. Images and PDFs are passed to the Claude CLI as real attachments. The `web_search` and " +
      "`web_fetch` server tools run on the Claude CLI's own WebSearch and WebFetch tools (`allowed_domains`, " +
      "`blocked_domains` and `max_uses` are passed on as instructions), and the reply comes back as text with the " +
      "sources cited, not as `server_tool_use` blocks. Note that web fetch requests come from the Task Manager's host. " +
      "Every enabled server in Settings → MCP Servers is attached to each request, as for task runs, and the model can " +
      "call its tools by itself. Other server tools, such as code execution, get a 400.",
    "**Tool calling on subscription CLIs:** the CLIs can't take a tool list, so tools are emulated. Your tool " +
      "definitions go into the system prompt, the model writes each call in a set format, and the gateway turns it " +
      "into a normal `tool_use` block (Anthropic) or `tool_calls` entry (OpenAI) with the matching stop reason. Your " +
      "client runs the tool and sends the result back as usual. When tools are sent, the reply streams in one chunk at " +
      "the end, because the whole reply has to be read before the calls can be found. `tool_choice` is followed, but " +
      "only through the prompt, so it's less reliable than on the API. A call to a tool you didn't define, or with " +
      "malformed arguments, comes back as text.",
  ],

  endpointsHead: ["Endpoint", "Format", "Description"],
  endpoints: [
    ["`POST /api/llm/v1/chat/completions`", "OpenAI", "Chat Completions. Set `stream: true` for SSE chunks ending in `[DONE]`; `stream_options.include_usage` adds a final usage chunk."],
    ["`POST /api/llm/v1/messages`", "Anthropic", "Messages API, streaming or not. Streams use the standard event types (`message_start`, `content_block_delta`, …)."],
    ["`POST /api/llm/v1/messages/count_tokens`", "Anthropic", "Exact on Anthropic API providers. An estimate (about 4 characters per token) on other providers."],
    ["`GET /api/llm/v1/models`", "Both", "The models the current provider can run, starting with `default`. Each entry has the fields both SDKs read."],
  ],

  errorsIntro:
    "Errors use the same shape as the API the client called, so SDKs raise their usual exception types. Errors from an " +
    "upstream API keep their original status. If an error happens after a stream has started, it arrives as an error " +
    "event in the stream.",
  errorsHead: ["Status", "Meaning"],
  errors: [
    ["400", "The request can't run on this provider, e.g. code execution sent to a subscription CLI, images sent to Codex, or a conversation that doesn't end with a user message."],
    ["401", "Missing or invalid API key. MCP tokens (`tm_mcp_…`) don't work here."],
    ["429", "The provider is rate-limited or out of plan usage, and no other provider is available. Retry later."],
    ["502", "The provider failed to answer (the CLI crashed, a network error, …)."],
    ["503", "No provider is configured or enabled, the CLI isn't installed, or its login has expired — or the gateway has been temporarily disabled (the message says until when, and timed pauses send `Retry-After`)."],
  ],

  notes: [
    "Requests use the same subscription or API account as your tasks. Heavy use here leaves less capacity for task runs, and the reverse.",
    "Requests are not tasks. They don't appear on the board, aren't logged, and never touch a repository.",
    "Each request's token usage (not its content) is recorded per API key. [Analytics → API Proxy](/analytics/gateway) shows when the gateway spends tokens (hourly for the last day, daily, and by hour of day), how many, and the estimated cost by model, API key and request; subscription usage is also priced at API rates there so you can see what it would cost. [Analytics](/analytics) compares it with what task runs spend, under \"Token Spend by Source\".",
    "You can disable the gateway temporarily — for 15 minutes up to 7 days, or until you turn it back on — from [Analytics → API Proxy](/analytics/gateway) or [Settings → API](/settings/api). While it's disabled every request with a valid key gets a 503; a timed pause ends on its own.",
    "The key's \"Last used\" time in Settings → API updates on every request, which is an easy way to confirm a service is connected. Use one key per service so you can revoke one without breaking the others.",
    "Requests to a subscription CLI start a CLI process, which adds a few seconds before the first token.",
  ],
};

export function llmGatewayMarkdown(origin: string): string {
  const d = LLM_GATEWAY_DOC;
  const urls = llmGatewayUrls(origin);
  return absoluteLinks(
    mdDoc(
      `# ${d.title}`,
      d.intro,
      mdList([`OpenAI base URL: \`${urls.openai}\``, `Anthropic base URL: \`${urls.anthropic}\``, `Auth: ${d.auth}`]),
      "## Setup",
      `### 1. Create an API key\n\n${d.setupKey}`,
      `### 2. Check which provider will answer\n\n${d.setupProvider}`,
      `### 3. Point your client at it\n\n${d.setupClient}`,
      ...llmGatewaySnippets(origin).map((s) => `**${s.label}**\n\n${mdCode(s.code, s.lang)}`),
      mdList(d.setupNotes),
      "## Choosing a model",
      d.modelsIntro,
      mdTable(d.modelsHead, d.models),
      d.modelsOutro,
      "## What works on each provider",
      d.providersIntro,
      mdTable(d.providersHead, d.providers),
      "### Translation notes",
      mdList(d.translationNotes),
      "## Endpoints",
      mdTable(d.endpointsHead, d.endpoints),
      "## Errors",
      d.errorsIntro,
      mdTable(d.errorsHead, d.errors),
      "## Good to know",
      mdList(d.notes),
    ),
    origin,
  );
}
