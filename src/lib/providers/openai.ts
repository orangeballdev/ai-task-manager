import OpenAI from "openai";
import fs from "fs";
import type { CancelChecker, ExecutionResult, MessageFetcher, Provider } from "./index";
import { executeTool } from "./tools";
import type { AgentEnvOverlay } from "../agent-tools";
import { resolveAttachmentPath } from "../attachments";

const TASK_COMPLETE_MARKER = "---TASK_COMPLETE---";
const MAX_ITERATIONS = 200;

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash command in the workspace directory. Use for reading files, running tests, git operations, installing packages, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path to the file" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, creating parent directories as needed",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path to the file" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "str_replace",
      description: "Replace an exact string in a file with a new string. The old_str must appear exactly once in the file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path to the file" },
          old_str: { type: "string", description: "The exact string to replace (must be unique in file)" },
          new_str: { type: "string", description: "The replacement string" },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
];

export class OpenAIProvider implements Provider {
  agentEnv?: AgentEnvOverlay;
  private apiKey: string;
  private model: string;
  private baseURL?: string;
  private timeoutMs: number;
  private maxTokens?: number;

  constructor(apiKey?: string, model?: string, baseURL?: string, timeoutMs?: number, maxTokens?: number) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = model ?? "gpt-4o";
    this.baseURL = baseURL;
    this.timeoutMs = timeoutMs ?? 3600000;
    this.maxTokens = maxTokens;
  }

  async execute(
    _taskId: string,
    prompt: import("./index").PromptContent,
    onOutput: (chunk: string, level?: "info" | "error" | "system") => void,
    getNextMessage?: MessageFetcher,
    cwd?: string,
    isCancelled?: CancelChecker,
    onTokenUpdate?: import("./index").TokenUpdateCallback,
  ): Promise<ExecutionResult> {
    const client = new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });

    // Build initial user content — include image attachments if present
    const userContent: OpenAI.ChatCompletionContentPart[] = [];
    if (prompt.attachments && prompt.attachments.length > 0) {
      for (const att of prompt.attachments) {
        const source = att.mimeType.startsWith("image/") ? resolveAttachmentPath(att) : null;
        if (source) {
          try {
            const data = fs.readFileSync(source).toString("base64");
            userContent.push({ type: "image_url", image_url: { url: `data:${att.mimeType};base64,${data}` } });
          } catch { /* skip unreadable files */ }
        }
      }
    }
    userContent.push({ type: "text", text: prompt.user });

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: prompt.system },
      { role: "user", content: userContent },
    ];

    const workspaceCwd = cwd ?? process.cwd();
    let completed = false;
    let iterations = 0;
    let timedOut = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheRead = 0;
    let responseModel: string | undefined;
    const stopReasons = new Set<string>();
    const usage = () => ({
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheRead,
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

        const stream = await client.chat.completions.create({
          model: this.model,
          max_tokens: 8096,
          tools: TOOLS,
          tool_choice: "auto",
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }, { signal: controller.signal });

        const toolCallsAcc: Array<{ id: string; name: string; arguments: string }> = [];
        let finishReason: string | null = null;
        let assistantContent = "";

        for await (const chunk of stream) {
          if (chunk.usage) {
            totalInputTokens += chunk.usage.prompt_tokens ?? 0;
            totalOutputTokens += chunk.usage.completion_tokens ?? 0;
            totalCacheRead += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          }
          if (chunk.model) responseModel = chunk.model;
          const delta = chunk.choices[0]?.delta;
          const reason = chunk.choices[0]?.finish_reason;
          if (reason) { finishReason = reason; stopReasons.add(reason); }

          if (delta?.content) {
            assistantContent += delta.content;
            if (delta.content.includes(TASK_COMPLETE_MARKER)) {
              completed = true;
              const clean = delta.content.replace(TASK_COMPLETE_MARKER, "").trimEnd();
              if (clean) onOutput(clean, "info");
            } else {
              onOutput(delta.content, "info");
            }
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallsAcc[idx]) {
                toolCallsAcc[idx] = { id: "", name: "", arguments: "" };
              }
              if (tc.id) toolCallsAcc[idx].id = tc.id;
              if (tc.function?.name) toolCallsAcc[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
            }
          }
        }

        if (onTokenUpdate) {
          void onTokenUpdate(totalInputTokens, totalOutputTokens);
        }

        if (this.maxTokens && (totalInputTokens + totalOutputTokens) >= this.maxTokens) {
          onOutput(`Token budget of ${this.maxTokens.toLocaleString()} tokens reached. Stopping execution gracefully.`, "system");
          return { success: true, shouldRetry: false, budgetExceeded: true, ...usage() };
        }

        if (completed || finishReason === "stop" || finishReason === null) {
          return { success: true, shouldRetry: false, ...usage() };
        }

        if (finishReason !== "tool_calls" || toolCallsAcc.length === 0) {
          return { success: true, shouldRetry: false, ...usage() };
        }

        const toolCallObjects: OpenAI.ChatCompletionMessageToolCall[] = toolCallsAcc.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));

        messages.push({
          role: "assistant",
          content: assistantContent || null,
          tool_calls: toolCallObjects,
        });

        for (const tc of toolCallObjects) {
          if (tc.type !== "function") continue;
          let input: Record<string, string>;
          try {
            input = JSON.parse(tc.function.arguments) as Record<string, string>;
          } catch {
            input = {};
          }
          onOutput(`[${tc.function.name}] ${tc.function.arguments}`, "system");
          const result = await executeTool(tc.function.name, input, workspaceCwd, this.agentEnv);
          onOutput(result.slice(0, 500) + (result.length > 500 ? "…" : ""), "system");
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
        }
      }

      return { success: false, shouldRetry: false, error: "Max iterations reached", ...usage() };
    } catch (err: unknown) {
      if (timedOut) {
        return { success: false, shouldRetry: false, error: "Task timed out", ...usage() };
      }
      if (err instanceof OpenAI.RateLimitError) {
        const retryAfter = new Date(Date.now() + 3600000);
        onOutput(`Rate limited. Will retry after ${retryAfter.toISOString()}`, "system");
        return { success: false, shouldRetry: true, retryAfter, ...usage() };
      }
      const msg = err instanceof Error ? err.message : String(err);
      onOutput(`Error: ${msg}`, "error");
      return { success: false, shouldRetry: false, error: msg, ...usage() };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
