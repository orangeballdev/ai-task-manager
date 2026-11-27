import { applyEnvOverlay, type AgentEnvOverlay } from "../agent-tools";
import type { AgentMcpConfig } from "../mcp-servers";
import { spawn } from "child_process";
import type { CancelChecker, ExecutionResult, MessageFetcher, PromptContent, Provider, TokenUpdateCallback } from "./index";
import {
  CODEX_MAX_ATTEMPTS,
  CODEX_NOT_FOUND_MESSAGE,
  CodexSignalTracker,
  classifyCodexStderr,
  codexCommand,
  codexEnv,
  codexExecArgs,
  codexResumeNotice,
  codexRetryDelayMs,
  createLineBuffer,
  decideCodexOutcome,
  findCodexBinary,
  killCodexProcessTree,
  parseCodexEvent,
  trackCodexChild,
} from "./codex-exec";

const TASK_COMPLETE_MARKER = "---TASK_COMPLETE---";

type OutputFn = (chunk: string, level?: "info" | "error" | "system") => void;

/** Outcome of one `codex exec` spawn, before the retry policy is applied. */
interface AttemptResult extends ExecutionResult {
  /** The process died of something a fresh spawn could plausibly get past. */
  transient?: boolean;
  /** Stop retrying regardless: cancelled, timed out, or the binary is missing. */
  terminal?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the locally-authenticated Codex CLI (ChatGPT or OpenAI login), not the API.
 *
 * Codex is noticeably flakier than the Claude CLI in two specific ways, and both used to
 * end the task:
 *
 * 1. `apply_patch verification failed` — the model's patch didn't match the file. Codex
 *    reports it, hands it back to the model, and the model retries. It is not a run failure,
 *    but it used to set `sawFailure` and turn a perfectly good exit-0 run into
 *    `Task failed: Codex CLI exited with code 0`.
 * 2. The `wss://chatgpt.com/backend-api/codex/responses` stream dropping. Codex reconnects
 *    up to five times on its own and then exits — often with status 0. There is nothing
 *    left to reconnect to at that point, so recovery means spawning a fresh `codex exec`
 *    (with a note telling the model to pick up from the work already on disk).
 *
 * Classification of both lives in `codex-exec.ts` so the assistant helpers and the health
 * check apply the same rules.
 */
export class CodexCliProvider implements Provider {
  agentEnv?: AgentEnvOverlay;
  mcp?: AgentMcpConfig;
  constructor(
    private timeoutMs = 3600000,
    private configDir?: string,
    private model?: string,
    private effort?: string,
  ) {}

  async execute(
    _taskId: string,
    prompt: PromptContent,
    onOutput: OutputFn,
    getNextMessage?: MessageFetcher,
    cwd?: string,
    isCancelled?: CancelChecker,
    onTokenUpdate?: TokenUpdateCallback,
  ): Promise<ExecutionResult> {
    // Fail fast with an actionable message instead of spawning and getting a bare ENOENT.
    if (!findCodexBinary()) {
      onOutput(CODEX_NOT_FOUND_MESSAGE, "error");
      return { success: false, shouldRetry: false, error: CODEX_NOT_FOUND_MESSAGE };
    }

    // The timeout is a budget for the whole task, not per attempt — otherwise three retries
    // could run for three times as long as the user asked for.
    const deadline = this.timeoutMs > 0 ? Date.now() + this.timeoutMs : 0;
    const basePrompt = `${prompt.system}\n\n${prompt.user}`;

    // `codex exec` with an empty prompt argument falls back to reading stdin ("Reading
    // additional input from stdin…") and, since we give it /dev/null, produces nothing at
    // all until the task timeout fires. Fail immediately instead of burning an hour.
    if (!basePrompt.trim()) {
      const message = "Refusing to run Codex with an empty prompt.";
      onOutput(message, "error");
      return { success: false, shouldRetry: false, error: message };
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;
    let last: AttemptResult = { success: false, shouldRetry: false, error: "Codex CLI did not run" };

    for (let attempt = 1; attempt <= CODEX_MAX_ATTEMPTS; attempt++) {
      const remaining = deadline ? deadline - Date.now() : 0;
      if (deadline && remaining <= 0) {
        last = { success: false, shouldRetry: false, error: "Task timed out", terminal: true };
        break;
      }

      const attemptPrompt =
        attempt === 1
          ? basePrompt
          : `${codexResumeNotice(attempt - 1, last.error ?? "connection lost")}\n\n${basePrompt}`;

      last = await this.runOnce({
        prompt: attemptPrompt,
        onOutput,
        getNextMessage,
        cwd,
        isCancelled,
        // Tokens accumulate across attempts so a retried task doesn't under-report usage.
        onTokenUpdate: (input, output) => {
          inputTokens = input;
          outputTokens = output;
          return onTokenUpdate?.(input, output);
        },
        timeoutMs: deadline ? remaining : 0,
      });

      if (last.cacheReadTokens != null) cacheReadTokens = (cacheReadTokens ?? 0) + last.cacheReadTokens;
      if (last.success || last.terminal || !last.transient) break;

      if (attempt === CODEX_MAX_ATTEMPTS) {
        onOutput(
          `Codex hit a connection problem on all ${CODEX_MAX_ATTEMPTS} attempts (${last.error ?? "unknown"}). Giving up.`,
          "error",
        );
        break;
      }

      const delay = codexRetryDelayMs(attempt);
      if (deadline && Date.now() + delay >= deadline) {
        onOutput("Codex hit a connection problem but the task's time budget is spent.", "error");
        break;
      }
      onOutput(
        `Codex hit a connection problem (${last.error ?? "stream disconnected"}). ` +
          `Restarting it in ${Math.round(delay / 1000)}s — attempt ${attempt + 1} of ${CODEX_MAX_ATTEMPTS}. ` +
          "Work already written to the workspace is kept.",
        "system",
      );
      await sleep(delay);
      try {
        if (await isCancelled?.()) {
          last = { success: false, shouldRetry: false, error: "Task killed", terminal: true };
          break;
        }
      } catch {
        /* can't tell — assume it's still wanted and retry */
      }
    }

    return {
      success: last.success,
      shouldRetry: last.shouldRetry,
      authFailed: last.authFailed,
      error: last.error,
      retryAfter: last.retryAfter,
      inputTokens,
      outputTokens,
      cacheReadTokens,
    };
  }

  /** One `codex exec` spawn. Never retries — the caller owns the retry policy. */
  private runOnce(opts: {
    prompt: string;
    onOutput: OutputFn;
    getNextMessage?: MessageFetcher;
    cwd?: string;
    isCancelled?: CancelChecker;
    onTokenUpdate: TokenUpdateCallback;
    timeoutMs: number;
  }): Promise<AttemptResult> {
    const { prompt, onOutput, getNextMessage, cwd, isCancelled, onTokenUpdate, timeoutMs } = opts;

    return new Promise((resolve) => {
      let done = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens: number | undefined;
      // Every failure/usage signal of this attempt: what failed, what Codex recovered from,
      // and whether a turn completed after the last wobble. Bounded and unit-tested.
      const tracker = new CodexSignalTracker();
      // Both streams arrive in arbitrary chunks, so neither may be classified before it has
      // been re-assembled into whole lines.
      const stdoutLines = createLineBuffer();
      const stderrLines = createLineBuffer();

      onOutput(`Spawning Codex CLI${cwd ? ` in: ${cwd}` : ""}`, "system");

      const args = [
        ...codexExecArgs({ cd: cwd, model: this.model, effort: this.effort, fullAccess: true }),
        // Settings → MCP Servers, as `--config mcp_servers.<name>.…` overrides.
        ...(this.mcp?.codexArgs ?? []),
        prompt,
      ];

      // `spawn` normally reports failures via the "error" event, but it throws synchronously
      // for things like a cwd that doesn't exist. Catching it here keeps that from escaping
      // as an unhandled rejection out of the promise executor.
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(codexCommand(), args, {
          stdio: ["ignore", "pipe", "pipe"],
          cwd,
          env: applyEnvOverlay(codexEnv(this.configDir), this.agentEnv),
          // Task runs bypass the sandbox, so Codex shells out to installs, builds and test
          // suites. Giving it its own process group is what makes it possible to kill those
          // too on a timeout or a cancelled task instead of leaking them (see `stop()`).
          detached: true,
        });
        trackCodexChild(child);
      } catch (err) {
        const message = `Failed to start Codex CLI: ${err instanceof Error ? err.message : String(err)}`;
        onOutput(message, "error");
        resolve({ success: false, shouldRetry: false, error: message, terminal: true });
        return;
      }

      const finish = (result: AttemptResult) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (poller) clearInterval(poller);
        if (messagePoller) clearInterval(messagePoller);
        resolve({ ...result, inputTokens, outputTokens, cacheReadTokens });
      };

      const emit = (line: string) => {
        const event = parseCodexEvent(line);
        if (!event) return;
        if (event.usage) {
          inputTokens = event.usage.inputTokens;
          outputTokens = event.usage.outputTokens;
          cacheReadTokens = event.usage.cachedInputTokens ?? cacheReadTokens;
          void onTokenUpdate(inputTokens, outputTokens);
        }
        tracker.event(event);
        if (!event.text) return;

        let text = event.text;
        if (event.isAgentMessage && text.includes(TASK_COMPLETE_MARKER)) {
          tracker.markCompletionMarker();
          text = text.replace(TASK_COMPLETE_MARKER, "").trimEnd();
          if (!text) return;
        }
        onOutput(text, event.level);
      };

      child.stdout?.on("data", (data: Buffer) => {
        // Once the attempt has been settled (timed out, cancelled) the process is on its way
        // out; anything still draining out of its pipes belongs to a run nobody is waiting
        // for, and logging it would append to a task the worker has already moved on from.
        if (done) return;
        stdoutLines.push(data.toString()).forEach(emit);
      });

      // Codex's `tracing` diagnostics go to stderr, including the ERROR-level lines it emits
      // for problems it is handling itself. Logging every one of them at "error" level made
      // healthy runs look broken, so each line is classified first — after being re-assembled,
      // since half a line reads as fatal however harmless the whole one is.
      const emitStderr = (line: string) => {
        for (const classified of classifyCodexStderr(line)) {
          tracker.stderrLine(classified);
          onOutput(classified.text, classified.level);
        }
      };

      child.stderr?.on("data", (data: Buffer) => {
        if (done) return;
        stderrLines.push(data.toString()).forEach(emitStderr);
      });

      child.on("close", (code) => {
        if (done) return;
        // Flush whatever the streams left without a trailing newline, or a final error line
        // (the interesting one, usually) is dropped.
        const trailingOut = stdoutLines.flush();
        if (trailingOut) emit(trailingOut);
        const trailingErr = stderrLines.flush();
        if (trailingErr) emitStderr(trailingErr);

        onOutput(`Codex CLI exited with code: ${code ?? "null"}`, "system");
        const { recoveredCount } = tracker;
        if (recoveredCount > 0) {
          onOutput(
            `Codex recovered from ${recoveredCount} tool error${recoveredCount === 1 ? "" : "s"} during this run (e.g. a patch that had to be reapplied). These are not failures.`,
            "system",
          );
        }

        const outcome = decideCodexOutcome(tracker.signals(code));
        finish({ ...outcome, terminal: outcome.shouldRetry || !!outcome.authFailed });
      });

      child.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        const message =
          code === "ENOENT" ? CODEX_NOT_FOUND_MESSAGE : `Failed to start Codex CLI: ${err.message}`;
        onOutput(message, "error");
        finish({
          success: false,
          shouldRetry: false,
          error: message,
          terminal: code === "ENOENT",
          // Out of pids/fds — worth another go once the host calms down.
          transient: code === "EAGAIN" || code === "EMFILE",
        });
      });

      // Signal the whole process group, not just `codex`: it is the build/test commands it
      // started that keep running (and keep the workspace busy) when only the parent is hit.
      const stop = () => {
        killCodexProcessTree(child, "SIGTERM");
        // Escalate if Codex ignores the polite signal, so we never leak the process.
        setTimeout(() => killCodexProcessTree(child, "SIGKILL"), 5000).unref?.();
      };

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              stop();
              finish({ success: false, shouldRetry: false, error: "Task timed out", terminal: true });
            }, timeoutMs)
          : undefined;

      const poller = isCancelled
        ? setInterval(async () => {
            try {
              if (await isCancelled()) {
                stop();
                finish({ success: false, shouldRetry: false, error: "Task killed", terminal: true });
              }
            } catch {
              /* a transient DB hiccup must not kill a running task */
            }
          }, 2000)
        : undefined;

      // `codex exec` is one-shot — there is no live session to inject a message into.
      // Drain any the user sends anyway and say so in the log, rather than leaving them
      // queued forever with no explanation.
      const messagePoller = getNextMessage
        ? setInterval(async () => {
            try {
              const msg = await getNextMessage();
              if (msg) {
                onOutput(
                  "Codex CLI runs non-interactively, so this message can't be delivered to the running agent. Add it to the task and retry to include it.",
                  "system",
                );
              }
            } catch {
              /* polling failures are never worth failing the run over */
            }
          }, 3000)
        : undefined;
    });
  }
}
