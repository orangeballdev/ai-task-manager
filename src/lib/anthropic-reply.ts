import type Anthropic from "@anthropic-ai/sdk";
import { modelSupportsEffort } from "./models";

/**
 * Helpers for the short, one-shot Anthropic calls behind the assistant features
 * (suggest title, enhance description, diagnose, verify, chat, Slack, …).
 *
 * Current Claude models (Opus 5.5, Fable 5.x, …) *always* think: the response
 * starts with a `thinking` block, and thinking tokens count against
 * `max_tokens`. Code that read `response.content[0].text` or asked for 60 output
 * tokens therefore came back empty — the first block wasn't text, and the budget
 * was spent before the answer began.
 */

/**
 * Floor for `max_tokens` on non-streaming assistant calls. It leaves room for
 * thinking before the answer. Answers are still as short as the prompt asks; a
 * higher cap is not a longer reply.
 */
export const MIN_ASSISTANT_MAX_TOKENS = 8192;

/** Joins every text block of a response, skipping thinking / tool_use blocks. */
export function responseText(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * `max_tokens` + `output_config` for a quick assistant call. Adds `effort` only
 * when the model accepts it; Haiku 4.5, for example, rejects the parameter with
 * a 400.
 */
export function assistantRequestOptions(
  model: string,
  requestedMaxTokens: number,
  effort: "low" | "medium" | "high" = "low",
): { max_tokens: number; output_config?: { effort: "low" | "medium" | "high" } } {
  return {
    max_tokens: Math.max(requestedMaxTokens, MIN_ASSISTANT_MAX_TOKENS),
    ...(modelSupportsEffort(model) ? { output_config: { effort } } : {}),
  };
}

/** Error thrown by replyText() when the model declines (`stop_reason: "refusal"`). */
export class ModelRefusalError extends Error {
  constructor() {
    super("The model declined to answer this request. Try rephrasing it, or pick a different model.");
    this.name = "ModelRefusalError";
  }
}

/**
 * Text of a complete assistant reply. Throws ModelRefusalError on a refusal, so
 * the UI gets a clear reason instead of an unexplained empty answer.
 */
export function replyText(message: Pick<Anthropic.Message, "content" | "stop_reason">): string {
  if (message.stop_reason === "refusal") throw new ModelRefusalError();
  return responseText(message.content);
}
