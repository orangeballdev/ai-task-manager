/**
 * LLM gateway runtime: runs an OpenAI- or Anthropic-format request on an AIProvider row.
 *
 * Exposed at `/api/llm/v1/*` so any service built for the OpenAI or Anthropic API can point
 * its base URL here, authenticate with a task-manager API key, and run on whatever provider
 * getProvider() resolves (the same chain the worker uses: smart pick → default → any enabled).
 *
 *   request format  │ api / claude-pki        │ openai                 │ cli / codex-cli
 *   ────────────────┼─────────────────────────┼────────────────────────┼──────────────────────
 *   Anthropic       │ pass-through            │ translated both ways   │ text-only, see below
 *   OpenAI          │ translated both ways    │ pass-through           │ text-only, see below
 *
 * Subscription CLIs run with every tool of their own disabled (`--tools ""` / `--sandbox
 * read-only`), like the other assistant helpers: the gateway never touches the host. The
 * *client's* tools are emulated — described in the system prompt, called with `<tool_call>`
 * blocks that are rewritten into real `tool_use` blocks — and the client runs them, as with
 * the API. The Claude CLI streams real token deltas (`--include-partial-messages` emits the
 * API's own stream events) except when tools are offered, where the reply must be parsed
 * whole first; Codex can't stream, so its finished answer is replayed as one burst.
 *
 * The pure translation lives in convert.ts / routing.ts (unit-tested).
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { homedir } from "os";
import { join } from "path";
import { prisma } from "@/lib/db";
import { DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { ApiProvider } from "@/lib/providers/api";
import { ClaudePkiProvider } from "@/lib/providers/claude-pki";
import { runCodexText } from "@/lib/providers/codex-exec";
import { syncCredentialsToDisk } from "@/lib/providers/cli-credentials";
import {
  AnthropicToOpenAIStream,
  CliTurnMerger,
  GatewayRequestError,
  OpenAIToAnthropicStream,
  accumulateAnthropicEvents,
  anthropicMessageToEvents,
  anthropicMessageToOpenAI,
  anthropicRequestToOpenAI,
  openaiCompletionToAnthropic,
  openaiRequestToAnthropic,
  textToAnthropicMessage,
} from "./convert";
import { applyCliToolCalls, buildCliPrompt, resolveGatewayModel, type CliPrompt } from "./routing";
import { loadEnabledMcpServers, prepareMcpServers } from "@/lib/mcp-servers-runtime";
import { buildCodexMcpArgs } from "@/lib/mcp-servers";

type AEvent = Anthropic.RawMessageStreamEvent;
type OAIChunk = OpenAI.Chat.ChatCompletionChunk;

export interface GatewayProvider {
  id: string;
  name: string;
  type: string;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  configDir: string | null;
  credentialsJson: string | null;
  pkiCertData: Uint8Array | null;
  pkiCertPassphrase: string | null;
  proxyUrl: string | null;
}

export interface GatewayOptions {
  signal?: AbortSignal;
  /** `anthropic-beta` header from the client, forwarded to Claude API providers. */
  anthropicBeta?: string | null;
}

export type AnthropicResult = { message: Anthropic.Message } | { stream: AsyncIterable<AEvent> };
export type OpenAIResult = { completion: OpenAI.Chat.ChatCompletion } | { stream: AsyncIterable<OAIChunk> };

/** A provider-side failure with the HTTP status the client should see. */
export class GatewayUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GatewayUpstreamError";
  }
}

const DEFAULT_OPENAI_MODEL = "gpt-4o";
const CLI_TIMEOUT_MS = 10 * 60 * 1000;

function buildAnthropicClient(p: GatewayProvider): Anthropic {
  if (p.type === "claude-pki") {
    if (!p.pkiCertData) throw new GatewayUpstreamError(`Provider "${p.name}" has no client certificate configured.`, 500);
    return new ClaudePkiProvider(
      Buffer.from(p.pkiCertData),
      p.pkiCertPassphrase || undefined,
      p.apiKey || undefined,
      undefined,
      p.baseUrl || undefined,
      p.proxyUrl || undefined,
    ).buildClient();
  }
  const apiKey = p.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new GatewayUpstreamError(`Provider "${p.name}" has no API key configured.`, 500);
  return new ApiProvider(apiKey, undefined, p.baseUrl || undefined).buildClient();
}

function buildOpenAIClient(p: GatewayProvider): OpenAI {
  const apiKey = p.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new GatewayUpstreamError(`Provider "${p.name}" has no API key configured.`, 500);
  return new OpenAI({ apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) });
}

function isClaudeApi(type: string): boolean {
  return type === "api" || type === "claude-pki";
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

async function* mapStream<In, Out>(
  source: AsyncIterable<In>,
  step: (item: In) => Out[],
  finish: () => Out[],
): AsyncGenerator<Out> {
  for await (const item of source) yield* step(item);
  yield* finish();
}

// ---------------------------------------------------------------------------
// Anthropic-format entry point (POST /v1/messages)
// ---------------------------------------------------------------------------

export async function runAnthropicRequest(
  provider: GatewayProvider,
  body: Anthropic.MessageCreateParams,
  opts: GatewayOptions = {},
): Promise<AnthropicResult> {
  const model = resolveGatewayModel(body.model, provider);
  return runAnthropicResolved(provider, body, model, opts);
}

async function runAnthropicResolved(
  provider: GatewayProvider,
  body: Anthropic.MessageCreateParams,
  model: string | undefined,
  opts: GatewayOptions,
): Promise<AnthropicResult> {
  const streaming = !!body.stream;

  if (isClaudeApi(provider.type)) {
    const client = buildAnthropicClient(provider);
    const requestOpts = {
      signal: opts.signal,
      ...(opts.anthropicBeta ? { headers: { "anthropic-beta": opts.anthropicBeta } } : {}),
    };
    const params = { ...body, model: model ?? DEFAULT_ASSISTANT_MODEL };
    if (streaming) {
      return { stream: await client.messages.create({ ...params, stream: true }, requestOpts) };
    }
    // .stream().finalMessage() rather than a plain create(): the SDK refuses non-streaming
    // calls whose max_tokens could outlast its HTTP timeout, and clients routinely ask for that.
    const { stream: _drop, ...rest } = params;
    void _drop;
    return { message: await client.messages.stream(rest, requestOpts).finalMessage() };
  }

  if (provider.type === "openai") {
    const client = buildOpenAIClient(provider);
    const req = anthropicRequestToOpenAI(body, model ?? DEFAULT_OPENAI_MODEL);
    if (streaming) {
      const upstream = await client.chat.completions.create({ ...req, stream: true }, { signal: opts.signal });
      const t = new OpenAIToAnthropicStream(req.model);
      return { stream: mapStream(upstream, (c) => t.push(c), () => t.finish()) };
    }
    const completion = await client.chat.completions.create({ ...req, stream: false }, { signal: opts.signal });
    return { message: openaiCompletionToAnthropic(completion, req.model) };
  }

  const prompt = buildCliPrompt(body);
  // Tools are emulated with <tool_call> blocks in the reply text (see routing.ts), so a reply
  // that may contain them is collected and rewritten before the client sees any of it.
  const toolNames = prompt.clientToolNames.length ? prompt.clientToolNames : null;
  const finish = (message: Anthropic.Message): AnthropicResult => {
    const final = toolNames ? applyCliToolCalls(message, toolNames) : message;
    return streaming ? { stream: fromArray(anthropicMessageToEvents(final)) } : { message: final };
  };

  if (provider.type === "codex-cli") {
    if (prompt.attachments.length) throw new GatewayRequestError("Images and PDFs aren't supported when the default provider is Codex. Use the Claude CLI or an API provider.");
    if (prompt.builtinTools.length) throw new GatewayRequestError("Web search/fetch isn't supported when the default provider is Codex. Use the Claude CLI or an API provider.");
    const mcp = await prepareGatewayMcp("codex-cli");
    try {
      const text = await runCodexText([prompt.system, mcp.promptSection, prompt.prompt].filter(Boolean).join("\n\n"), {
        configDir: provider.configDir,
        credentialsJson: provider.credentialsJson,
        model,
        timeoutMs: CLI_TIMEOUT_MS,
        extraArgs: mcp.codexArgs,
      }).catch((err) => { throw toUpstreamError(err); });
      return finish(textToAnthropicMessage(text, model ?? "codex"));
    } finally {
      await mcp.cleanup();
    }
  }

  const mcp = await prepareGatewayMcp("cli");
  const events = claudeCliEvents(provider, prompt, model, body.output_config?.effort ?? undefined, mcp, opts.signal);
  if (streaming && !toolNames) return { stream: events };
  const collected: AEvent[] = [];
  for await (const ev of events) collected.push(ev);
  return finish(accumulateAnthropicEvents(collected, model ?? "claude"));
}

interface PreparedMcpServers {
  claudeConfigPath?: string;
  codexArgs?: string[];
  serverNames: string[];
  promptSection: string;
  cleanup: () => Promise<void>;
}

/**
 * The enabled servers from Settings → MCP Servers, for one gateway request — the same set and
 * config files a task run gets. A server that fails to prepare never fails the request: it
 * just runs without MCP.
 */
async function prepareGatewayMcp(providerType: "cli" | "codex-cli"): Promise<PreparedMcpServers> {
  const none: PreparedMcpServers = { serverNames: [], promptSection: "", cleanup: async () => {} };
  try {
    const prepared = await prepareMcpServers(`llm-${Date.now().toString(36)}`, providerType);
    if (!prepared.mcp) {
      await prepared.cleanup();
      return none;
    }
    const servers = await loadEnabledMcpServers();
    const skipped = providerType === "codex-cli" ? buildCodexMcpArgs(servers).skipped : [];
    return {
      claudeConfigPath: prepared.mcp.claudeConfigPath,
      codexArgs: prepared.mcp.codexArgs,
      serverNames: servers.map((s) => s.name).filter((n) => !skipped.includes(n)),
      promptSection: prepared.promptSection,
      cleanup: prepared.cleanup,
    };
  } catch (err) {
    console.warn("[llm-gateway] MCP servers not attached:", err instanceof Error ? err.message : err);
    return none;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-format entry point (POST /v1/chat/completions)
// ---------------------------------------------------------------------------

export async function runOpenAIRequest(
  provider: GatewayProvider,
  body: OpenAI.Chat.ChatCompletionCreateParams,
  opts: GatewayOptions = {},
): Promise<OpenAIResult> {
  const model = resolveGatewayModel(body.model, provider);

  if (provider.type === "openai") {
    const client = buildOpenAIClient(provider);
    const params = { ...body, model: model ?? DEFAULT_OPENAI_MODEL };
    if (body.stream) {
      return { stream: await client.chat.completions.create({ ...params, stream: true }, { signal: opts.signal }) };
    }
    return { completion: await client.chat.completions.create({ ...params, stream: false }, { signal: opts.signal }) };
  }

  const fallbackModel = isClaudeApi(provider.type) ? DEFAULT_ASSISTANT_MODEL : "";
  const anthropicReq = openaiRequestToAnthropic(body, model ?? fallbackModel);
  const result = await runAnthropicResolved(provider, anthropicReq, model ?? (fallbackModel || undefined), opts);

  if ("message" in result) return { completion: anthropicMessageToOpenAI(result.message) };
  const includeUsage = !!(body.stream && body.stream_options?.include_usage);
  const t = new AnthropicToOpenAIStream(model ?? provider.model ?? "default", includeUsage);
  return { stream: mapStream(result.stream, (ev) => t.push(ev), () => t.finish()) };
}

// ---------------------------------------------------------------------------
// Claude CLI
// ---------------------------------------------------------------------------

function cliExpiresAt(credentialsJson: string): number {
  try {
    return (JSON.parse(credentialsJson) as { claudeAiOauth?: { expiresAt?: number } })?.claudeAiOauth?.expiresAt ?? 0;
  } catch {
    return 0;
  }
}

async function syncCliCredentials(provider: GatewayProvider): Promise<void> {
  if (!provider.credentialsJson) return;
  try {
    const others = await prisma.aIProvider.findMany({
      where: { type: "cli", id: { not: provider.id } },
      select: { credentialsJson: true },
    });
    // Ownership-aware, like the worker and health check: never runs on another connection's login.
    syncCredentialsToDisk({
      providerId: provider.id,
      dir: provider.configDir?.trim() || join(homedir(), ".claude"),
      fileName: ".credentials.json",
      credentialsJson: provider.credentialsJson,
      expiresAtOf: cliExpiresAt,
      otherProviderCredentials: others.map((o: { credentialsJson: string | null }) => o.credentialsJson),
    });
  } catch {
    /* non-fatal — the CLI may still have a usable login on disk */
  }
}

const LIMIT_PATTERN = /usage limit|rate.?limit|limit reached|too many requests|overloaded/i;
const AUTH_PATTERN = /failed to authenticate|oauth|invalid api key|not logged in|please run \/login/i;

function toUpstreamError(err: unknown): GatewayUpstreamError {
  if (err instanceof GatewayUpstreamError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const status = LIMIT_PATTERN.test(message) ? 429 : AUTH_PATTERN.test(message) ? 503 : 502;
  return new GatewayUpstreamError(message, status);
}

/**
 * Runs `claude -p` and yields the Anthropic stream events it prints. The CLI wraps each raw API
 * event in `{"type":"stream_event","event":…}`; if a CLI build doesn't emit those, the final
 * `result` text is replayed as a single message instead.
 *
 * What the CLI may use is exactly what the request (and Settings) grants: the built-in tools
 * standing in for the API's server tools (`WebSearch`/`WebFetch`), and the enabled MCP servers
 * from Settings → MCP Servers. Nothing else — no Bash, no file tools, no slash commands, no
 * saved session. Images/PDFs go in as a stream-json user message on stdin.
 */
async function* claudeCliEvents(
  provider: GatewayProvider,
  prompt: CliPrompt,
  model: string | undefined,
  effort: string | undefined,
  mcp: PreparedMcpServers,
  signal?: AbortSignal,
): AsyncGenerator<AEvent> {
  await syncCliCredentials(provider);

  const system = [prompt.system, mcp.promptSection].filter(Boolean).join("\n\n");
  const allowed = [...prompt.builtinTools, ...mcp.serverNames.map((n) => `mcp__${n}`)];
  const withStdin = prompt.attachments.length > 0;

  const args = [
    "--system-prompt", system,
    "-p", ...(withStdin ? [] : [prompt.prompt]),
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", prompt.builtinTools.join(","),
    // Only Settings → MCP Servers, never a stray .mcp.json or the host user's own config.
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
  if (withStdin) args.push("--input-format", "stream-json");
  if (mcp.claudeConfigPath) args.push("--mcp-config", mcp.claudeConfigPath);
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);

  const child = spawn("claude", args, {
    cwd: "/tmp",
    stdio: [withStdin ? "pipe" : "ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: undefined,
      PATH: [process.env.PATH ?? "", process.env.CLAUDE_PATH].filter(Boolean).join(":"),
      ...(provider.configDir ? { CLAUDE_CONFIG_DIR: provider.configDir } : {}),
    },
  });
  if (withStdin && child.stdin) {
    child.stdin.on("error", () => { /* surfaces as the exit code / stderr below */ });
    child.stdin.end(`${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt.prompt }, ...prompt.attachments] },
    })}\n`);
  }

  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
  const exit = new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
    child.on("close", (code) => resolve({ code }));
    child.on("error", (error: NodeJS.ErrnoException) => resolve({ code: null, error }));
  });
  const kill = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, CLI_TIMEOUT_MS);

  const merger = new CliTurnMerger();
  let sawEvents = false;
  let resultText: string | null = null;
  let resultError: string | null = null;
  let resultUsage: { input_tokens?: number; output_tokens?: number } | undefined;

  try {
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "stream_event" && msg.event) {
        sawEvents = true;
        yield* merger.push(msg.event as AEvent);
      } else if (msg.type === "result") {
        const text = typeof msg.result === "string" ? msg.result : "";
        if (msg.is_error || (msg.subtype && msg.subtype !== "success")) resultError = text || String(msg.subtype);
        else resultText = text;
        resultUsage = msg.usage as typeof resultUsage;
      }
    }

    const { code, error } = await exit;
    if (error) {
      throw new GatewayUpstreamError(
        error.code === "ENOENT" ? "Claude CLI not found on the server's PATH." : `Failed to start Claude CLI: ${error.message}`,
        503,
      );
    }
    if (signal?.aborted) return;
    if (resultError) throw toUpstreamError(new Error(resultError));
    if (!sawEvents) {
      if (resultText !== null) {
        yield* anthropicMessageToEvents(textToAnthropicMessage(resultText, model ?? "claude", resultUsage));
        return;
      }
      const detail = stderr.trim() || `Claude CLI exited with code ${code}`;
      throw toUpstreamError(new Error(detail));
    }
    yield* merger.finish();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    kill();
    await mcp.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Token counting (POST /v1/messages/count_tokens)
// ---------------------------------------------------------------------------

/** Exact count from the Claude API where possible, otherwise a ~4 chars/token estimate. */
export async function countGatewayTokens(
  provider: GatewayProvider,
  body: Anthropic.MessageCountTokensParams,
  anthropicBeta?: string | null,
): Promise<number> {
  if (isClaudeApi(provider.type)) {
    const client = buildAnthropicClient(provider);
    const model = resolveGatewayModel(body.model, provider) ?? DEFAULT_ASSISTANT_MODEL;
    const res = await client.messages.countTokens(
      { ...body, model },
      anthropicBeta ? { headers: { "anthropic-beta": anthropicBeta } } : undefined,
    );
    return res.input_tokens;
  }
  const chars = JSON.stringify([body.system ?? "", body.messages ?? [], body.tools ?? []]).length;
  return Math.ceil(chars / 4);
}
