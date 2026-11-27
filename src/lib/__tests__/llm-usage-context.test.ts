import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCliText, llmCallStorage, reportAnthropicUsage, reportLlmUsage, type LlmCallUsage } from "../llm-usage-context";

test("reportLlmUsage is a no-op outside a traced call", () => {
  assert.doesNotThrow(() => reportLlmUsage({ inputTokens: 5 }));
});

test("usage accumulates across the calls of one traced call (a Slack tool loop)", () => {
  const state: LlmCallUsage = { usage: {}, calls: 0 };
  llmCallStorage.run(state, () => {
    reportAnthropicUsage({ model: "claude-opus-5-5", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100 } });
    reportAnthropicUsage({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 3 } });
  });
  assert.equal(state.calls, 2);
  assert.deepEqual(state.usage, {
    inputTokens: 30, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: undefined,
    responseModel: "claude-opus-5-5", finishReasons: ["end_turn"],
  });
});

test("claudeCliText unwraps JSON output and passes plain text through", () => {
  const state: LlmCallUsage = { usage: {}, calls: 0 };
  const text = llmCallStorage.run(state, () => claudeCliText(JSON.stringify({ type: "result", result: " hi ", usage: { input_tokens: 1, output_tokens: 1 } })));
  assert.equal(text, "hi");
  assert.equal(state.calls, 1);
  assert.equal(claudeCliText("plain reply"), "plain reply");
});
