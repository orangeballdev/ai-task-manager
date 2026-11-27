import { detectProviderAuthFailure } from "../auth-failure";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import { resolveAttachmentPath } from "../attachments";
import type { CancelChecker, ExecutionResult, PromptContent, Provider } from "./index";
import { executeTool } from "./tools";
import { DEFAULT_ASSISTANT_MODEL, modelSupportsEffort } from "@/lib/models";
import type { AgentEnvOverlay } from "../agent-tools";

const TASK_COMPLETE_MARKER = "---TASK_COMPLETE---";
const MAX_ITERATIONS = 200;
// Tool results larger than this are truncated to prevent runaway token growth
const MAX_TOOL_RESULT_CHARS = 20000;
// Per-response output cap. Current models (Opus 5.5, Fable 5.x) always think, and
// thinking counts against max_tokens — the old 8096 cap regularly cut a turn off
// mid-thought or mid-tool-call. Requests are streamed, so a large cap is safe.
const MAX_OUTPUT_TOKENS = 64000;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Execute a bash command in the workspace directory. Use for reading files, running tests, git operations, installing packages, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The bash command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the content of a file",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative or absolute path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating parent directories as needed",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative or absolute path to the file" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "str_replace",
    description: "Replace an exact string in a file with a new string. The old_str must appear exactly once in the file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative or absolute path to the file" },
        old_str: { type: "string", description: "The exact string to replace (must be unique in file)" },
        new_str: { type: "string", description: "The replacement string" },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
];

// Mark the last tool with cache_control so the full tools array is cached
const CACHED_TOOLS: Anthropic.Tool[] = TOOLS.map((t, i) =>
  i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } as const } : t
);

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
  return `${result.slice(0, half)}\n\n[... ${(result.length - MAX_TOOL_RESULT_CHARS).toLocaleString()} chars truncated ...]\n\n${result.slice(-half)}`;
}

export class ApiProvider implements Provider {
  agentEnv?: AgentEnvOverlay;
  protected apiKey: string;
  protected model: string;
  protected baseURL?: string;
  protected timeoutMs: number;
  protected maxTokens?: number;
  // Thinking-effort override — forwarded as `output_config.effort` on each
  // request. One of "low" | "medium" | "high" | "xhigh" | "max" (see
  // src/lib/effort.ts). "xhigh" is Opus 4.7+ only; unsupported values are
  // simply rejected by the API, so callers should only set this from the
  // validated EFFORT_LEVELS list.
  protected effort?: string;

  constructor(apiKey?: string, model?: string, baseURL?: string, timeoutMs?: number, maxTokens?: number, effort?: string) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.model = model ?? DEFAULT_ASSISTANT_MODEL;
    this.baseURL = baseURL;
    this.timeoutMs = timeoutMs ?? 3600000;
    this.maxTokens = maxTokens;
    this.effort = effort;
  }

  /**
   * Builds the Anthropic client used for this run. Subclasses (e.g. ClaudePkiProvider)
   * override this to customize the transport (mutual-TLS client certs, proxy, etc.)
   * while reusing the rest of the tool-use execution loop below. Public so callers
   * like the health-check liveness probe can build a client without running a task.
   */
  buildClient(): Anthropic {
    const clientOptions: ConstructorParameters<typeof Anthropic>[0] = {
      apiKey: this.apiKey,
    };
    if (this.baseURL) clientOptions.baseURL = this.baseURL;
    return new Anthropic(clientOptions);
  }

  async execute(
    _taskId: string,
    prompt: PromptContent,
    onOutput: (chunk: string, level?: "info" | "error" | "system") => void,
    getNextMessage?: import("./index").MessageFetcher,
    cwd?: string,
    isCancelled?: CancelChecker,
    onTokenUpdate?: import("./index").TokenUpdateCallback,
  ): Promise<ExecutionResult> {
    const client = this.buildClient();

    // Cache the system prompt — it's static for the entire task run
    const systemWithCache: Anthropic.TextBlockParam[] = [
      { type: "text", text: prompt.system, cache_control: { type: "ephemeral" } },
    ];

    // Build initial user message content — prepend images if attachments are present
    const initialContent: Anthropic.ContentBlockParam[] = [];
    if (prompt.attachments && prompt.attachments.length > 0) {
      for (const att of prompt.attachments) {
        const validMimeTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
        type ImageMime = typeof validMimeTypes[number];
        const mimeType = validMimeTypes.includes(att.mimeType as ImageMime) ? att.mimeType as ImageMime : null;
        const source = mimeType ? resolveAttachmentPath(att) : null;
        if (mimeType && source) {
          try {
            const data = fs.readFileSync(source).toString("base64");
            initialContent.push({ type: "image", source: { type: "base64", media_type: mimeType, data } });
          } catch { /* skip unreadable files */ }
        }
      }
    }
    initialContent.push({ type: "text", text: prompt.user, cache_control: { type: "ephemeral" } });

    // Cache the initial user message (task description + pre-loaded context) too
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: initialContent,
      },
    ];

    // Haiku 4.5 and older models reject `output_config.effort` with a 400. Drop
    // it instead of failing the whole task over an optional setting.
    const effort = this.effort && modelSupportsEffort(this.model) ? this.effort : undefined;
    if (this.effort && !effort) {
      onOutput(`Model ${this.model} does not support the "${this.effort}" effort setting; running with the model's default.`, "system");
    }

    const workspaceCwd = cwd ?? process.cwd();
    let completed = false;
    let iterations = 0;
    let timedOut = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let responseModel: string | undefined;
    const stopReasons = new Set<string>();
    const usage = () => ({
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      model: responseModel,
      finishReasons: stopReasons.size ? [...stopReasons] : undefined,
    });

    const controller = new AbortController();
    const timer = this.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
          const minutes = Math.round(this.timeoutMs / 60000);
          onOutput(`Task timed out after ${minutes} minute${minutes !== 1 ? "s" : ""}`, "error");
        }, this.timeoutMs)
      : null;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        if (isCancelled && await isCancelled()) {
          return { success: false, shouldRetry: false, error: "Task killed" };
        }

        if (getNextMessage && iterations > 1) {
          const nextMsg = await getNextMessage();
          if (nextMsg) {
            messages.push({ role: "user", content: nextMsg.content });
            onOutput(nextMsg.content, "user" as "info");
          }
        }

        const stream = client.messages.stream({
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemWithCache,
          tools: CACHED_TOOLS,
          messages,
          ...(effort ? { output_config: { effort: effort as Anthropic.OutputConfig["effort"] } } : {}),
        }, { signal: controller.signal });

        stream.on("text", (delta: string) => {
          if (delta.includes(TASK_COMPLETE_MARKER)) {
            completed = true;
            const clean = delta.replace(TASK_COMPLETE_MARKER, "").trimEnd();
            if (clean) onOutput(clean, "info");
          } else {
            onOutput(delta, "info");
          }
        });

        const message = await stream.finalMessage();

        totalInputTokens += message.usage?.input_tokens ?? 0;
        totalOutputTokens += message.usage?.output_tokens ?? 0;
        totalCacheRead += message.usage?.cache_read_input_tokens ?? 0;
        totalCacheCreation += message.usage?.cache_creation_input_tokens ?? 0;
        responseModel = message.model || responseModel;
        if (message.stop_reason) stopReasons.add(message.stop_reason);

        if (onTokenUpdate) {
          void onTokenUpdate(totalInputTokens, totalOutputTokens);
        }

        if (this.maxTokens && (totalInputTokens + totalOutputTokens) >= this.maxTokens) {
          onOutput(`Token budget of ${this.maxTokens.toLocaleString()} tokens reached. Stopping execution gracefully.`, "system");
          return { success: true, shouldRetry: false, budgetExceeded: true, ...usage() };
        }

        if (message.stop_reason === "refusal") {
          const category = message.stop_details?.category;
          const error = `The model declined to continue this task${category ? ` (safety category: ${category})` : ""}. Rephrase the task or run it on a different model.`;
          onOutput(error, "error");
          return { success: false, shouldRetry: false, error, ...usage() };
        }

        if (completed || message.stop_reason === "end_turn") {
          return { success: true, shouldRetry: false, ...usage() };
        }

        if (message.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: message.content });
          continue;
        }

        const toolUseBlocks = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        // Output cap hit mid-turn. That is not "done", and a tool call cut off at
        // the cap may have incomplete input, so don't run it. Keep the history
        // append-only (current models reject edited turns that carry thinking
        // blocks): echo the turn back, then ask the model to continue.
        if (message.stop_reason === "max_tokens") {
          onOutput("Response hit the output limit; asking the model to continue.", "system");
          messages.push({ role: "assistant", content: message.content });
          messages.push({
            role: "user",
            content: [
              ...toolUseBlocks.map((tool): Anthropic.ToolResultBlockParam => ({
                type: "tool_result",
                tool_use_id: tool.id,
                content: "Not executed: your response hit the output limit, so this call's input may be incomplete. Re-issue it if still needed.",
                is_error: true,
              })),
              { type: "text", text: "Your previous response was cut off by the output limit. Continue from where you left off." },
            ],
          });
          continue;
        }

        if (toolUseBlocks.length === 0) {
          return { success: true, shouldRetry: false, ...usage() };
        }

        messages.push({ role: "assistant", content: message.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tool of toolUseBlocks) {
          onOutput(`[${tool.name}] ${JSON.stringify(tool.input)}`, "system");
          const raw = await executeTool(
            tool.name,
            tool.input as Record<string, string>,
            workspaceCwd,
            this.agentEnv,
          );
          const result = truncateToolResult(raw);
          onOutput(result.slice(0, 500) + (result.length > 500 ? "…" : ""), "system");
          toolResults.push({
            type: "tool_result",
            tool_use_id: tool.id,
            content: result,
          });
        }

        messages.push({ role: "user", content: toolResults });
      }

      return { success: false, shouldRetry: false, error: "Max iterations reached", ...usage() };
    } catch (err: unknown) {
      if (timedOut) {
        return { success: false, shouldRetry: false, error: "Task timed out", ...usage() };
      }
      if (err instanceof Anthropic.RateLimitError) {
        const retryAfter = new Date(Date.now() + 3600000);
        onOutput(`Rate limited. Will retry after ${retryAfter.toISOString()}`, "system");
        return { success: false, shouldRetry: true, retryAfter, ...usage() };
      }
      const msg = err instanceof Error ? err.message : String(err);
      onOutput(`Error: ${msg}`, "error");
      // A rejected key / expired login: let the worker move the task to another provider.
      if (err instanceof Anthropic.AuthenticationError || detectProviderAuthFailure(msg)) {
        return { success: false, shouldRetry: false, authFailed: true, error: msg, ...usage() };
      }
      return { success: false, shouldRetry: false, error: msg, ...usage() };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
