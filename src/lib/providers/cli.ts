import { detectProviderAuthFailure, tailLines } from "../auth-failure";
import { spawn } from "child_process";
import { parseOutput } from "../output-parser";
import { recordCommandResult } from "../verification-state";
import { agentTelemetryEnv, currentOtelConfig } from "../otel-config";
import type { CancelChecker, ExecutionResult, Provider, TokenUpdateCallback } from "./index";
import { applyEnvOverlay, type AgentEnvOverlay } from "../agent-tools";
import type { AgentMcpConfig } from "../mcp-servers";
import { ToolSpanTracker } from "./tool-spans";

const TASK_COMPLETE_MARKER = "---TASK_COMPLETE---";

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
      | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
    >;
    usage?: TokenUsage;
    model?: string;
  };
  result?: string;
  is_error?: boolean;
  usage?: TokenUsage;
  /** On the final `result` event: why the last model turn stopped (`end_turn`, `max_tokens`, …). */
  stop_reason?: string | null;
}

/**
 * Pairs Bash `tool_use` blocks with the `tool_result` that reports their
 * outcome, so build/lint/test runs can be written to the workspace's
 * verification ledger (see src/lib/verification-state.ts). Nothing here is
 * logged — it only feeds the resume prompt.
 */
interface BashTracker {
  pending: Map<string, string>;
  workspacePath?: string;
}

// Markers that mean a command failed even if the event didn't set `is_error`.
// Only used to *downgrade* a result: a false "failed" costs one re-run, while a
// false "passed" would let a resumed agent skip a check that never succeeded.
const FAILURE_MARKERS = /(?:^|\n)\s*Error:|Command failed|exit code (?!0\b)\d+/i;

function toolResultLooksFailed(block: { content?: unknown; is_error?: boolean }): boolean {
  if (block.is_error) return true;
  const content = block.content;
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return FAILURE_MARKERS.test(text);
}

interface ProcessResult {
  completed: boolean;
  inputTokens: number;
  outputTokens: number;
}

function processStreamEvent(
  event: StreamEvent,
  onOutput: (chunk: string, level?: "info" | "error" | "system") => void,
  bashTracker?: BashTracker,
): ProcessResult {
  let completed = false;
  let inputTokens = 0;
  let outputTokens = 0;

  if (event.type === "assistant" && event.message?.content) {
    // Extract token usage from the message-level usage field
    inputTokens += event.message.usage?.input_tokens ?? 0;
    outputTokens += event.message.usage?.output_tokens ?? 0;
    for (const block of event.message.content) {
      if (block.type === "text") {
        if (block.text.includes(TASK_COMPLETE_MARKER)) {
          completed = true;
          const clean = block.text.replace(TASK_COMPLETE_MARKER, "").trimEnd();
          if (clean) onOutput(clean, "info");
        } else if (block.text) {
          onOutput(block.text, "info");
        }
      } else if (block.type === "tool_use") {
        onOutput(`[${block.name}] ${JSON.stringify(block.input)}`, "system");
        if (bashTracker && /^bash$/i.test(block.name)) {
          const command = (block.input as { command?: unknown } | null)?.command;
          if (typeof command === "string" && command.trim()) {
            bashTracker.pending.set(block.id, command);
          }
        }
      }
    }
  } else if (event.type === "user" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use") {
        onOutput(`[tool_result] ${JSON.stringify((block as { type: string; text?: string }).text ?? block)}`, "system");
      } else if (block.type === "tool_result" && bashTracker) {
        const command = bashTracker.pending.get(block.tool_use_id);
        if (command !== undefined) {
          bashTracker.pending.delete(block.tool_use_id);
          recordCommandResult(bashTracker.workspacePath, command, !toolResultLooksFailed(block));
        }
      }
    }
  } else if (event.type === "result") {
    // The result event contains cumulative usage for the whole session.
    // Do NOT re-output the result text — it was already streamed via assistant events.
    inputTokens += event.usage?.input_tokens ?? 0;
    outputTokens += event.usage?.output_tokens ?? 0;
    if (event.subtype === "success") {
      // Only check for the completion marker; the text itself was already streamed
      if ((event.result ?? "").includes(TASK_COMPLETE_MARKER)) {
        completed = true;
      }
    } else if (event.is_error && event.result) {
      onOutput(event.result, "error");
    }
  }

  return { completed, inputTokens, outputTokens };
}

export class CliProvider implements Provider {
  agentEnv?: AgentEnvOverlay;
  mcp?: AgentMcpConfig;
  private timeoutMs: number;
  private maxTokens?: number;
  private configDir?: string;
  private model?: string;
  private maxOutputTokens?: number;
  // Thinking-effort override — forwarded to the CLI as `--effort <level>`.
  // One of "low" | "medium" | "high" | "xhigh" | "max" (see src/lib/effort.ts).
  private effort?: string;

  constructor(timeoutMs?: number, maxTokens?: number, configDir?: string, model?: string, maxOutputTokens?: number, effort?: string) {
    this.timeoutMs = timeoutMs ?? 3600000;
    this.maxTokens = maxTokens;
    this.configDir = configDir;
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
    this.effort = effort;
  }

  async execute(
    taskId: string,
    prompt: import("./index").PromptContent,
    onOutput: (chunk: string, level?: "info" | "error" | "system") => void,
    _getNextMessage?: import("./index").MessageFetcher,
    cwd?: string,
    isCancelled?: CancelChecker,
    onTokenUpdate?: TokenUpdateCallback,
  ): Promise<ExecutionResult> {
    // Tools run inside the CLI; their spans are rebuilt from its event stream (telemetry only).
    const toolSpans = new ToolSpanTracker();
    return new Promise<ExecutionResult>((resolve) => {
      const infoOutput: string[] = [];
      const stderrOutput: string[] = [];
      const errorOutput: string[] = [];
      let completed = false;
      let resolved = false;
      let budgetExceeded = false;
      let lineBuffer = "";
      let killProcess: (() => void) | null = null;
      // Token tracking: prefer the result event's cumulative total; fall back to per-assistant accumulation
      let accInputTokens = 0;
      let accOutputTokens = 0;
      let resultInputTokens: number | null = null;
      let resultOutputTokens: number | null = null;
      // Telemetry only: prompt-cache usage (from the cumulative result event) and the model that answered.
      let cacheReadTokens: number | undefined;
      let cacheCreationTokens: number | undefined;
      let responseModel: string | undefined;
      let finalStopReason: string | undefined;

      const trackingOnOutput = (chunk: string, level?: "info" | "error" | "system") => {
        if (level === "info") infoOutput.push(chunk);
        if (level === "error") errorOutput.push(chunk);
        onOutput(chunk, level);
      };

      const bashTracker: BashTracker = { pending: new Map(), workspacePath: cwd };

      const handleEvent = (event: StreamEvent) => {
        for (const block of event.message?.content ?? []) {
          if (event.type === "assistant" && block.type === "tool_use") toolSpans.start(block.id, block.name, block.input);
          else if (event.type === "user" && block.type === "tool_result") toolSpans.end(block.tool_use_id, block.is_error, block.content);
        }
        const r = processStreamEvent(event, trackingOnOutput, bashTracker);
        if (r.completed) completed = true;
        if (event.type === "result" && event.usage) {
          // result event has the session-level cumulative total — prefer this
          resultInputTokens = event.usage.input_tokens ?? null;
          resultOutputTokens = event.usage.output_tokens ?? null;
          cacheReadTokens = event.usage.cache_read_input_tokens ?? cacheReadTokens;
          cacheCreationTokens = event.usage.cache_creation_input_tokens ?? cacheCreationTokens;
          if (event.stop_reason) finalStopReason = event.stop_reason;
          if (onTokenUpdate) {
            const inp = resultInputTokens ?? accInputTokens;
            const out = resultOutputTokens ?? accOutputTokens;
            void onTokenUpdate(inp, out);
          }
        } else if (event.type === "assistant") {
          if (event.message?.model) responseModel = event.message.model;
          accInputTokens += r.inputTokens;
          accOutputTokens += r.outputTokens;
          if (onTokenUpdate) {
            void onTokenUpdate(accInputTokens, accOutputTokens);
          }
          // Check token budget after accumulating from each assistant message
          if (this.maxTokens && !budgetExceeded && (accInputTokens + accOutputTokens) >= this.maxTokens) {
            budgetExceeded = true;
            onOutput(`Token budget of ${this.maxTokens.toLocaleString()} tokens reached. Stopping execution gracefully.`, "system");
            if (killProcess) killProcess();
          }
        }
      };

      const getTokens = () => ({
        inputTokens: resultInputTokens ?? (accInputTokens > 0 ? accInputTokens : undefined),
        outputTokens: resultOutputTokens ?? (accOutputTokens > 0 ? accOutputTokens : undefined),
        cacheReadTokens,
        cacheCreationTokens,
        model: responseModel,
        finishReasons: finalStopReason ? [finalStopReason] : undefined,
      });

      onOutput(`Spawning Claude CLI${cwd ? ` in: ${cwd}` : ""}`, "system");

      // Image attachments are copied into the workspace by the worker before any
      // provider runs (copyAttachmentsToWorkspace() in runTask), so every provider
      // type — and every team stage — sees them, and a missing file is logged.

      const cliArgs = ["--system-prompt", prompt.system, "-p", prompt.user, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
      if (this.model) cliArgs.push("--model", this.model);
      if (this.effort) cliArgs.push("--effort", this.effort);
      // Settings → MCP Servers: additive to any .mcp.json the cloned repos bring along.
      if (this.mcp?.claudeConfigPath) cliArgs.push("--mcp-config", this.mcp.claudeConfigPath);

      const child = spawn("claude", cliArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd,
        env: applyEnvOverlay({
          ...process.env,
          PATH: [process.env.PATH ?? "", process.env.CLAUDE_PATH].filter(Boolean).join(":"),
          ...(this.configDir ? { CLAUDE_CONFIG_DIR: this.configDir } : {}),
          ...(this.maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(this.maxOutputTokens) } : {}),
          // Opt-in (Settings → Observability): Claude Code exports its own telemetry to our collector.
          ...(() => { const otel = currentOtelConfig(); return otel ? agentTelemetryEnv(otel, { "ctm.task.id": taskId }) : {}; })(),
        }, this.agentEnv),
      });

      killProcess = () => child.kill("SIGTERM");
      onOutput(`Claude CLI started (PID: ${child.pid})`, "system");

      const timer = this.timeoutMs > 0
        ? setTimeout(() => {
            if (resolved) return;
            resolved = true;
            child.kill("SIGTERM");
            const minutes = Math.round(this.timeoutMs / 60000);
            onOutput(`Task timed out after ${minutes} minute${minutes !== 1 ? "s" : ""}`, "error");
            resolve({ success: false, shouldRetry: false, error: "Task timed out", ...getTokens() });
          }, this.timeoutMs)
        : undefined;

      let cancelPoller: ReturnType<typeof setInterval> | null = null;
      if (isCancelled) {
        cancelPoller = setInterval(async () => {
          try {
            if (await isCancelled()) {
              clearInterval(cancelPoller!);
              cancelPoller = null;
              child.kill("SIGTERM");
              if (!resolved) {
                resolved = true;
                if (timer) clearTimeout(timer);
                onOutput("Task cancelled by user", "system");
                resolve({ success: false, shouldRetry: false, error: "Task killed", ...getTokens() });
              }
            }
          } catch { /* ignore */ }
        }, 2000);
      }

      const finish = (code: number | null) => {
        if (cancelPoller) { clearInterval(cancelPoller); cancelPoller = null; }
        if (timer) clearTimeout(timer);
        if (resolved) return;
        resolved = true;

        // Flush any remaining buffered line
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer) as StreamEvent;
            handleEvent(event);
          } catch {
            trackingOnOutput(lineBuffer, "info");
          }
          lineBuffer = "";
        }

        onOutput(`Claude CLI exited with code: ${code ?? "null"}`, "system");

        if (budgetExceeded) {
          resolve({ success: true, shouldRetry: false, budgetExceeded: true, ...getTokens() });
          return;
        }

        // If the task already completed successfully, never treat it as rate-limited.
        // Scan stderr + error events with full pattern set; scan assistant info text
        // with high-confidence patterns only (the Pro CLI emits "You've hit your limit
        // · resets …" through stdout assistant text, but generic mentions of rate
        // limits in Claude's own discussion should not trigger a retry).
        if (!completed) {
          const errText = stderrOutput.join("") + "\n" + errorOutput.join("\n");
          const errParsed = parseOutput(errText, { includeAmbiguous: true });
          if (errParsed.shouldRetry) {
            resolve({ success: false, shouldRetry: true, retryAfter: errParsed.retryAfter, ...getTokens() });
            return;
          }
          const infoParsed = parseOutput(infoOutput.join("\n"));
          if (infoParsed.shouldRetry) {
            resolve({ success: false, shouldRetry: true, retryAfter: infoParsed.retryAfter, ...getTokens() });
            return;
          }
        }

        if (code === 0 || completed) {
          resolve({ success: true, shouldRetry: false, ...getTokens() });
        } else {
          // A dead login ("Failed to authenticate: OAuth session expired and could not be
          // refreshed") isn't the task's fault. Only diagnostic output is scanned — stderr,
          // error events and the last few lines the CLI printed before exiting — so an agent
          // merely *discussing* auth can't trip it.
          const authLine = detectProviderAuthFailure(
            [stderrOutput.join(""), errorOutput.join("\n"), tailLines(infoOutput)].join("\n"),
          );
          if (authLine) {
            resolve({ success: false, shouldRetry: false, authFailed: true, error: authLine, ...getTokens() });
            return;
          }
          resolve({ success: false, shouldRetry: false, error: `CLI exited with code ${code}`, ...getTokens() });
        }
      };

      child.stdout.on("data", (data: Buffer) => {
        lineBuffer += data.toString();

        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as StreamEvent;
            handleEvent(event);
          } catch {
            // Not valid JSON — forward as raw text
            trackingOnOutput(trimmed, "info");
          }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderrOutput.push(chunk);
        onOutput(chunk.trimEnd(), "error");
      });

      child.on("close", finish);
      child.on("error", (err) => {
        if (cancelPoller) { clearInterval(cancelPoller); cancelPoller = null; }
        clearTimeout(timer);
        if (resolved) return;
        resolved = true;
        const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "Claude CLI not found. Install it from https://claude.ai/download and make sure it is on your PATH."
          : `Failed to start Claude CLI: ${err.message}`;
        onOutput(msg, "error");
        resolve({ success: false, shouldRetry: false, error: msg });
      });
    }).finally(() => toolSpans.endAll());
  }
}
