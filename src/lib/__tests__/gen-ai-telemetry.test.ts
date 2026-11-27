import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicStreamUsage,
  OpenAIStreamUsage,
  agentRunErrorType,
  agentRunUsage,
  anthropicMessageUsage,
  errorTypeOf,
  evaluationAttributes,
  humanReviewEvaluation,
  savedSpanContext,
  taskOutcomeEvaluation,
  genAiProviderName,
  openaiCompletionUsage,
  parseClaudeCliJson,
  usageAttributes,
} from "../gen-ai-telemetry";

test("genAiProviderName maps our provider types to semconv vendor names", () => {
  assert.equal(genAiProviderName("cli"), "anthropic");
  assert.equal(genAiProviderName("claude-pki"), "anthropic");
  assert.equal(genAiProviderName("codex-cli"), "openai");
  assert.equal(genAiProviderName(null), "unknown");
});

test("usageAttributes only emits what is known", () => {
  assert.deepEqual(usageAttributes({}), {});
  assert.deepEqual(
    usageAttributes({ inputTokens: 0, outputTokens: 5, cacheReadTokens: 7, responseModel: "m", finishReasons: ["stop"] }),
    {
      "gen_ai.usage.input_tokens": 0,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_read.input_tokens": 7,
      "gen_ai.response.model": "m",
      "gen_ai.response.finish_reasons": ["stop"],
    },
  );
});

test("agentRunUsage carries tokens, cache and model from the result", () => {
  const u = agentRunUsage({
    success: true, shouldRetry: false, inputTokens: 10, outputTokens: 20,
    cacheReadTokens: 30, cacheCreationTokens: 40, model: "claude-opus-5-5", finishReasons: ["tool_use", "max_tokens"],
  });
  assert.deepEqual(u, {
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40,
    responseModel: "claude-opus-5-5", finishReasons: ["tool_use", "max_tokens"],
  });
  // Only the model's own stop reasons — none are invented for a run that didn't report any.
  assert.equal(agentRunUsage({ success: true, shouldRetry: false, budgetExceeded: true }).finishReasons, undefined);
  assert.equal(agentRunUsage({ success: false, shouldRetry: false, finishReasons: [] }).finishReasons, undefined);
});

test("agentRunErrorType classifies failures without leaking messages", () => {
  assert.equal(agentRunErrorType({ success: true, shouldRetry: false }), undefined);
  assert.equal(agentRunErrorType({ success: false, shouldRetry: false, authFailed: true, error: "401" }), "authentication");
  assert.equal(agentRunErrorType({ success: false, shouldRetry: true }), "rate_limited");
  assert.equal(agentRunErrorType({ success: false, shouldRetry: false, error: "Task timed out" }), "timeout");
  assert.equal(agentRunErrorType({ success: false, shouldRetry: false, error: "Task killed" }), "cancelled");
  assert.equal(agentRunErrorType({ success: false, shouldRetry: false, error: "Max iterations reached" }), "max_iterations");
  assert.equal(agentRunErrorType({ success: false, shouldRetry: false, error: "CLI exited with code 1" }), "agent_error");
});

test("errorTypeOf prefers an HTTP status, then a class name", () => {
  assert.equal(errorTypeOf(Object.assign(new Error("x"), { status: 429 })), "429");
  class GatewayRequestError extends Error { name = "GatewayRequestError"; }
  assert.equal(errorTypeOf(new GatewayRequestError("bad")), "GatewayRequestError");
  assert.equal(errorTypeOf(new Error("plain")), "_OTHER");
  assert.equal(errorTypeOf("nope"), "_OTHER");
});

test("anthropicMessageUsage reads usage, cache tokens, model and stop reason", () => {
  assert.deepEqual(
    anthropicMessageUsage({
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 100, cache_creation_input_tokens: null },
    }),
    {
      inputTokens: 12, outputTokens: 34, cacheReadTokens: 100, cacheCreationTokens: undefined,
      responseModel: "claude-sonnet-5-5", finishReasons: ["end_turn"],
    },
  );
});

test("AnthropicStreamUsage folds message_start and the cumulative message_delta", () => {
  const acc = new AnthropicStreamUsage();
  acc.push({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 9 } } } as never);
  acc.push({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } as never);
  acc.push({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 77 } } as never);
  assert.deepEqual(acc.result(), {
    inputTokens: 50, outputTokens: 77, cacheReadTokens: 9, responseModel: "claude-sonnet-5-5", finishReasons: ["max_tokens"],
  });
});

test("openaiCompletionUsage reads prompt/completion and cached tokens", () => {
  assert.deepEqual(
    openaiCompletionUsage({
      model: "gpt-5",
      usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
      choices: [{ finish_reason: "stop" }],
    }),
    { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, responseModel: "gpt-5", finishReasons: ["stop"] },
  );
});

test("OpenAIStreamUsage takes usage from the final include_usage chunk", () => {
  const acc = new OpenAIStreamUsage();
  acc.push({ model: "gpt-5", choices: [{ finish_reason: null }] });
  acc.push({ model: "gpt-5", choices: [{ finish_reason: "tool_calls" }] });
  assert.deepEqual(acc.result(), { responseModel: "gpt-5", finishReasons: ["tool_calls"] });
  acc.push({ model: "gpt-5", choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } });
  assert.deepEqual(acc.result(), { responseModel: "gpt-5", finishReasons: ["tool_calls"], inputTokens: 8, outputTokens: 2 });
});

test("parseClaudeCliJson returns the reply text and the main model's usage", () => {
  // Shape of a real `claude -p --output-format json` result: the housekeeping model out-produces
  // the main one, so the model must come from the entry matching the top-level usage.
  const out = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "ok\n", stop_reason: "max_tokens",
    usage: { input_tokens: 2, cache_creation_input_tokens: 2496, cache_read_input_tokens: 649, output_tokens: 4 },
    modelUsage: {
      "claude-haiku-5-5": { inputTokens: 1173, outputTokens: 15, costUSD: 0.0001 },
      "claude-opus-5-5": { inputTokens: 2, outputTokens: 4, costUSD: 0.02 },
    },
  });
  assert.deepEqual(parseClaudeCliJson(out), {
    text: "ok",
    usage: {
      inputTokens: 2, outputTokens: 4, cacheReadTokens: 649, cacheCreationTokens: 2496,
      responseModel: "claude-opus-5-5", finishReasons: ["max_tokens"],
    },
  });
});

test("parseClaudeCliJson falls back to the most expensive model, and rejects non-results", () => {
  const out = JSON.stringify({
    type: "result", is_error: true, result: "Credit balance too low", usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { a: { inputTokens: 9, outputTokens: 9, costUSD: 0.001 }, b: { inputTokens: 8, outputTokens: 8, costUSD: 0.5 } },
  });
  const parsed = parseClaudeCliJson(out);
  assert.equal(parsed?.text, "Credit balance too low");
  assert.equal(parsed?.usage.responseModel, "b");
  assert.equal(parsed?.usage.finishReasons, undefined);
  assert.equal(parseClaudeCliJson("Add OAuth sign-in"), null);
  assert.equal(parseClaudeCliJson('{"type":"assistant"}'), null);
  assert.equal(parseClaudeCliJson("{not json"), null);
});

test("agentRunErrorType names refusals and content-policy blocks", () => {
  assert.equal(agentRunErrorType({ success: false, shouldRetry: false, finishReasons: ["refusal"], error: "The model declined" }), "refusal");
  assert.equal(agentRunErrorType({ success: false, shouldRetry: false, finishReasons: ["content_filter"] }), "content_filter");
  assert.equal(agentRunErrorType({ success: false, shouldRetry: false, error: "Your request was flagged as potentially violating our usage policy" }), "content_filter");
  // A refusal the run survived is not an error.
  assert.equal(agentRunErrorType({ success: true, shouldRetry: false, finishReasons: ["refusal"] }), undefined);
});

test("errorTypeOf recognises provider content-policy codes", () => {
  assert.equal(errorTypeOf({ status: 400, code: "content_policy_violation" }), "content_filter");
  assert.equal(errorTypeOf({ status: 400, error: { code: "content_filter" } }), "content_filter");
  assert.equal(errorTypeOf({ status: 400, error: { code: "invalid_request_error" } }), "400");
});

test("taskOutcomeEvaluation scores only final statuses", () => {
  assert.deepEqual(taskOutcomeEvaluation("completed"), { name: "task_outcome", scoreValue: 1, scoreLabel: "pass" });
  assert.equal(taskOutcomeEvaluation("no_changes")?.scoreValue, 1);
  assert.equal(taskOutcomeEvaluation("failed")?.scoreValue, 0);
  for (const s of ["pending", "paused", "throttled", "killed", "unknown"]) assert.equal(taskOutcomeEvaluation(s), null);
});

test("human review evaluations and their semconv attributes", () => {
  assert.equal(humanReviewEvaluation("approved").scoreValue, 1);
  assert.equal(humanReviewEvaluation("merged").scoreValue, 1);
  assert.equal(humanReviewEvaluation("changes_requested").scoreValue, 0);
  assert.deepEqual(evaluationAttributes(humanReviewEvaluation("merged"), { taskId: "t1", providerType: "codex-cli", model: "gpt-5" }), {
    "gen_ai.evaluation.name": "human_review",
    "gen_ai.evaluation.score.value": 1,
    "gen_ai.evaluation.score.label": "merged",
    "gen_ai.conversation.id": "t1",
    "ctm.task.id": "t1",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "gpt-5",
  });
});

test("savedSpanContext accepts only valid hex ids", () => {
  const t = "0af7651916cd43dd8448eb211c80319c", s = "b7ad6b7169203331";
  assert.deepEqual(savedSpanContext(t, s), { traceId: t, spanId: s });
  assert.equal(savedSpanContext(null, s), null);
  assert.equal(savedSpanContext(t, undefined), null);
  assert.equal(savedSpanContext("0".repeat(32), s), null);
  assert.equal(savedSpanContext(t, "0".repeat(16)), null);
  assert.equal(savedSpanContext("XYZ", s), null);
  assert.equal(savedSpanContext(t.toUpperCase(), s), null);
});
