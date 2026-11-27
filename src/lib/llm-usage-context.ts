/**
 * The token usage of the model call currently being traced by `traceLlmCall()`
 * (src/lib/gen-ai-otel.ts), carried in async context so the code that actually talks to the
 * model — an SDK call, a `claude -p` spawn, `runCodexText()` — can report usage with one line
 * and no signature changes. Reporting outside a traced call is a no-op. No SDK imports, so
 * any module (including the worker's providers) can call `reportLlmUsage()`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  anthropicMessageUsage, openaiCompletionUsage, parseClaudeCliJson, type GenAiUsage,
} from "./gen-ai-telemetry";

export interface LlmCallUsage {
  usage: GenAiUsage;
  /** Model calls folded into this one (a Slack turn's tool loop makes several). */
  calls: number;
}

export const llmCallStorage = new AsyncLocalStorage<LlmCallUsage>();

function sum(a?: number, b?: number): number | undefined {
  return a == null && b == null ? undefined : (a ?? 0) + (b ?? 0);
}

/** Adds one model call's usage to the traced call in progress (tokens accumulate). */
export function reportLlmUsage(u: GenAiUsage): void {
  const call = llmCallStorage.getStore();
  if (!call) return;
  const cur = call.usage;
  call.calls += 1;
  call.usage = {
    inputTokens: sum(cur.inputTokens, u.inputTokens),
    outputTokens: sum(cur.outputTokens, u.outputTokens),
    cacheReadTokens: sum(cur.cacheReadTokens, u.cacheReadTokens),
    cacheCreationTokens: sum(cur.cacheCreationTokens, u.cacheCreationTokens),
    responseModel: u.responseModel ?? cur.responseModel,
    finishReasons: u.finishReasons ?? cur.finishReasons,
  };
}

/** Reports an Anthropic Messages API response's usage. */
export function reportAnthropicUsage(msg: Parameters<typeof anthropicMessageUsage>[0]): void {
  try { reportLlmUsage(anthropicMessageUsage(msg)); } catch { /* telemetry only */ }
}

/** Reports an OpenAI Chat Completions response's usage. */
export function reportOpenAIUsage(completion: Parameters<typeof openaiCompletionUsage>[0]): void {
  try { reportLlmUsage(openaiCompletionUsage(completion)); } catch { /* telemetry only */ }
}

/**
 * `claude -p --output-format json` output → the reply text that `--output-format text`
 * would have printed, reporting the run's usage on the way. Output that isn't the JSON
 * result (an older CLI, a crash before it printed) comes back unchanged.
 */
export function claudeCliText(output: string): string {
  const parsed = parseClaudeCliJson(output);
  if (!parsed) return output;
  reportLlmUsage(parsed.usage);
  return parsed.text;
}
