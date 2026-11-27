/**
 * Pure half of the GenAI telemetry (OpenTelemetry `gen_ai.*` semantic conventions):
 * provider naming, error classification, and reading token usage / model / finish
 * reasons out of provider results and Anthropic/OpenAI responses and stream events.
 * No SDK imports, so it is unit-testable and safe to import anywhere.
 *
 * Who emits what (see CLAUDE.md → Observability):
 *  - worker: one `invoke_agent <agent>` span per agent run / team stage carrying the run's
 *    aggregate usage (the model calls happen inside the claude/codex process, out of reach),
 *    plus `execute_tool <tool>` children for the API providers' in-process tools;
 *  - LLM gateway: one `chat <model>` span per request.
 * Exactly one span per unit of model work carries `gen_ai.usage.*`, so backends that sum
 * tokens per span (ObiStack's AI pages) don't double count — `task.run` uses `ctm.*` names.
 */
import type { Attributes } from "@opentelemetry/api";

/** gen_ai.provider.name well-known value for one of our provider types. */
export function genAiProviderName(providerType: string | null | undefined): string {
  switch (providerType) {
    case "cli": case "api": case "claude-pki": return "anthropic";
    case "openai": case "codex-cli": return "openai";
    default: return providerType ?? "unknown";
  }
}

export interface GenAiUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** The model that actually answered. */
  responseModel?: string;
  finishReasons?: string[];
}

/** `gen_ai.usage.*` / `gen_ai.response.*` span attributes for whatever usage is known. */
export function usageAttributes(u: GenAiUsage): Attributes {
  const attrs: Attributes = {};
  if (u.inputTokens != null) attrs["gen_ai.usage.input_tokens"] = u.inputTokens;
  if (u.outputTokens != null) attrs["gen_ai.usage.output_tokens"] = u.outputTokens;
  if (u.cacheReadTokens != null) attrs["gen_ai.usage.cache_read.input_tokens"] = u.cacheReadTokens;
  if (u.cacheCreationTokens != null) attrs["gen_ai.usage.cache_creation.input_tokens"] = u.cacheCreationTokens;
  if (u.responseModel) attrs["gen_ai.response.model"] = u.responseModel;
  if (u.finishReasons?.length) attrs["gen_ai.response.finish_reasons"] = u.finishReasons;
  return attrs;
}

/** The subset of an agent run's ExecutionResult telemetry reads (kept structural to avoid an import cycle). */
export interface AgentRunOutcome {
  success: boolean;
  shouldRetry: boolean;
  budgetExceeded?: boolean;
  authFailed?: boolean;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
  finishReasons?: string[];
}

/**
 * Usage of a finished agent run. Finish reasons are only the model's own (`end_turn`,
 * `max_tokens`, `length`, …) — never invented — so "truncated replies" queries stay truthful.
 */
export function agentRunUsage(r: AgentRunOutcome): GenAiUsage {
  return {
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    responseModel: r.model,
    finishReasons: r.finishReasons?.length ? r.finishReasons : undefined,
  };
}

/**
 * `error.type` for a failed agent run: a low-cardinality class, never the message itself.
 * Undefined when the run succeeded.
 */
export function agentRunErrorType(r: AgentRunOutcome): string | undefined {
  if (r.success) return undefined;
  if (r.authFailed) return "authentication";
  if (r.shouldRetry) return "rate_limited";
  if (r.finishReasons?.some((f) => /refusal/i.test(f))) return "refusal";
  if (r.finishReasons?.some((f) => /content_filter/i.test(f))) return "content_filter";
  const e = r.error ?? "";
  if (CONTENT_POLICY_RE.test(e)) return "content_filter";
  if (/timed out/i.test(e)) return "timeout";
  if (/killed|cancel/i.test(e)) return "cancelled";
  if (/max iterations/i.test(e)) return "max_iterations";
  return "agent_error";
}

/** Provider wording/codes for a request blocked by a content policy (not merely discussed by the agent: only matched against error text). */
const CONTENT_POLICY_RE = /content[_ ]?(policy|filter|management)|usage polic(y|ies)|flagged as potentially|invalid_prompt/i;

// ---------------------------------------------------------------------------
// Evaluations (`gen_ai.evaluation.result` events)
// ---------------------------------------------------------------------------

/**
 * One quality judgement about an agent's work, emitted as a `gen_ai.evaluation.result`
 * event. We don't run LLM judges; these are signals the app already has:
 *  - `task_outcome` — how a run ended (pass / no_changes = 1, fail = 0);
 *  - `human_review` — what a person did with the result (approved / merged = 1,
 *    changes_requested = 0).
 */
export interface GenAiEvaluation {
  name: "task_outcome" | "human_review";
  scoreValue: number;
  scoreLabel: string;
  explanation?: string;
}

/** `task_outcome` for a task status after a run, or null for statuses that aren't a verdict (retry, pause, kill). */
export function taskOutcomeEvaluation(status: string, errorType?: string): GenAiEvaluation | null {
  switch (status) {
    case "completed": return { name: "task_outcome", scoreValue: 1, scoreLabel: "pass" };
    case "no_changes": return { name: "task_outcome", scoreValue: 1, scoreLabel: "no_changes", explanation: "Agent finished without changing the repository" };
    case "failed": return { name: "task_outcome", scoreValue: 0, scoreLabel: "fail", ...(errorType ? { explanation: errorType } : {}) };
    default: return null;
  }
}

export type ReviewVerdict = "approved" | "merged" | "changes_requested";

export function humanReviewEvaluation(verdict: ReviewVerdict): GenAiEvaluation {
  return { name: "human_review", scoreValue: verdict === "changes_requested" ? 0 : 1, scoreLabel: verdict };
}

export interface EvaluationSubject {
  taskId: string;
  providerType?: string | null;
  model?: string | null;
}

/**
 * The trace/span ids saved on a task (`Task.telemetryTraceId`/`telemetrySpanId`) as a span
 * context to parent a late evaluation on, or null when they're missing or malformed (an
 * all-zero id is OTel's "invalid" marker, so it's rejected too).
 */
export function savedSpanContext(traceId: string | null | undefined, spanId: string | null | undefined): { traceId: string; spanId: string } | null {
  if (!traceId || !spanId) return null;
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId };
}

/** Attributes of a `gen_ai.evaluation.result` event (semconv names; the task is the conversation). */
export function evaluationAttributes(e: GenAiEvaluation, subject: EvaluationSubject): Attributes {
  return {
    "gen_ai.evaluation.name": e.name,
    "gen_ai.evaluation.score.value": e.scoreValue,
    "gen_ai.evaluation.score.label": e.scoreLabel,
    ...(e.explanation ? { "gen_ai.evaluation.explanation": e.explanation } : {}),
    "gen_ai.conversation.id": subject.taskId,
    "ctm.task.id": subject.taskId,
    ...(subject.providerType ? { "gen_ai.provider.name": genAiProviderName(subject.providerType) } : {}),
    ...(subject.model ? { "gen_ai.request.model": subject.model } : {}),
  };
}

/** `error.type` for a thrown error: an HTTP status when it carries one, else its class name. */
export function errorTypeOf(err: unknown): string {
  if (err && typeof err === "object") {
    // A provider's content-policy block (OpenAI `content_policy_violation`/`content_filter`,
    // Azure `content_filter`) — named so "prompt rejected" queries can find it.
    const e = err as { code?: unknown; error?: { code?: unknown; type?: unknown } };
    const code = [e.code, e.error?.code, e.error?.type].find((c) => typeof c === "string") as string | undefined;
    if (code && CONTENT_POLICY_RE.test(code)) return "content_filter";
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status > 0) return String(status);
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name && name !== "Error") return name;
  }
  return "_OTHER";
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface AnthropicMessageLike {
  model?: string;
  stop_reason?: string | null;
  usage?: AnthropicUsageLike | null;
}

export function anthropicMessageUsage(msg: AnthropicMessageLike): GenAiUsage {
  const u = msg.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? undefined,
    outputTokens: u.output_tokens ?? undefined,
    cacheReadTokens: u.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: u.cache_creation_input_tokens ?? undefined,
    responseModel: msg.model || undefined,
    finishReasons: msg.stop_reason ? [msg.stop_reason] : undefined,
  };
}

/**
 * Folds Anthropic stream events into usage: `message_start` carries the model and input
 * usage, each `message_delta` the cumulative output tokens (and, on newer APIs, input) and
 * the stop reason.
 */
export class AnthropicStreamUsage {
  private usage: GenAiUsage = {};

  push(event: { type?: string }): void {
    const ev = event as { type?: string; message?: AnthropicMessageLike; usage?: AnthropicUsageLike | null; delta?: { stop_reason?: string | null } };
    if (ev.type === "message_start" && ev.message) {
      this.usage = { ...this.usage, ...strip(anthropicMessageUsage(ev.message)) };
    } else if (ev.type === "message_delta") {
      const u = ev.usage ?? {};
      if (u.output_tokens != null) this.usage.outputTokens = u.output_tokens;
      if (u.input_tokens != null) this.usage.inputTokens = u.input_tokens;
      if (u.cache_read_input_tokens != null) this.usage.cacheReadTokens = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens != null) this.usage.cacheCreationTokens = u.cache_creation_input_tokens;
      if (ev.delta?.stop_reason) this.usage.finishReasons = [ev.delta.stop_reason];
    }
  }

  result(): GenAiUsage {
    return { ...this.usage };
  }
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

interface OpenAIUsageLike {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

interface OpenAICompletionLike {
  model?: string;
  usage?: OpenAIUsageLike | null;
  choices?: Array<{ finish_reason?: string | null }>;
}

function openaiUsage(u: OpenAIUsageLike | null | undefined): GenAiUsage {
  if (!u) return {};
  return {
    inputTokens: u.prompt_tokens ?? undefined,
    outputTokens: u.completion_tokens ?? undefined,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? undefined,
  };
}

function finishReasonsOf(choices: OpenAICompletionLike["choices"]): string[] | undefined {
  const reasons = (choices ?? []).map((c) => c.finish_reason).filter((r): r is string => !!r);
  return reasons.length ? reasons : undefined;
}

export function openaiCompletionUsage(c: OpenAICompletionLike): GenAiUsage {
  return strip({ ...openaiUsage(c.usage), responseModel: c.model || undefined, finishReasons: finishReasonsOf(c.choices) });
}

/** Folds OpenAI stream chunks into usage (tokens only arrive when the client asked for `include_usage`). */
export class OpenAIStreamUsage {
  private usage: GenAiUsage = {};

  push(chunk: OpenAICompletionLike): void {
    if (chunk.model) this.usage.responseModel = chunk.model;
    if (chunk.usage) Object.assign(this.usage, strip(openaiUsage(chunk.usage)));
    const reasons = finishReasonsOf(chunk.choices);
    if (reasons) this.usage.finishReasons = reasons;
  }

  result(): GenAiUsage {
    return { ...this.usage };
  }
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Claude CLI (`claude -p --output-format json`)
// ---------------------------------------------------------------------------

interface ClaudeCliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  usage?: AnthropicUsageLike;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }>;
  stop_reason?: string | null;
}

/**
 * Parses the single JSON result `claude -p --output-format json` prints: the reply text
 * (what `--output-format text` prints) plus usage. The top-level `usage` is the main model's
 * only; `modelUsage` also lists the small model the CLI uses for housekeeping, which can
 * out-produce a short main reply. So the model is the entry whose counts match `usage`,
 * else the most expensive one.
 * Returns null for anything that isn't that result object.
 */
export function parseClaudeCliJson(output: string): { text: string; usage: GenAiUsage } | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return null;
  let r: ClaudeCliResult;
  try {
    r = JSON.parse(trimmed) as ClaudeCliResult;
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || r.type !== "result") return null;
  const u = r.usage ?? {};
  const models = Object.entries(r.modelUsage ?? {});
  const model =
    models.find(([, m]) => m?.inputTokens === u.input_tokens && m?.outputTokens === u.output_tokens)?.[0] ??
    models.sort((a, b) => (b[1]?.costUSD ?? 0) - (a[1]?.costUSD ?? 0))[0]?.[0];
  return {
    text: (r.result ?? "").trim(),
    usage: strip({
      inputTokens: u.input_tokens ?? undefined,
      outputTokens: u.output_tokens ?? undefined,
      cacheReadTokens: u.cache_read_input_tokens ?? undefined,
      cacheCreationTokens: u.cache_creation_input_tokens ?? undefined,
      responseModel: model,
      finishReasons: r.stop_reason ? [r.stop_reason] : undefined,
    }),
  };
}
