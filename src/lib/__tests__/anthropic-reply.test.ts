import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  assistantRequestOptions,
  MIN_ASSISTANT_MAX_TOKENS,
  ModelRefusalError,
  replyText,
  responseText,
} from "../anthropic-reply";
import { modelSupportsEffort } from "../models";

const thinking = { type: "thinking", thinking: "", signature: "sig" } as unknown as Anthropic.ContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Anthropic.ContentBlock;

describe("responseText", () => {
  it("skips a leading thinking block (Opus 5.5 always thinks)", () => {
    assert.equal(responseText([thinking, text("  Add login page  ")]), "Add login page");
  });
  it("joins multiple text blocks", () => {
    assert.equal(responseText([text("a"), thinking, text("b")]), "a\nb");
  });
  it("is empty when there is no text", () => {
    assert.equal(responseText([thinking]), "");
  });
});

describe("replyText", () => {
  it("returns the text of a normal reply", () => {
    assert.equal(replyText({ content: [thinking, text("ok")], stop_reason: "end_turn" }), "ok");
  });
  it("throws a clear error on a refusal", () => {
    assert.throws(() => replyText({ content: [], stop_reason: "refusal" }), ModelRefusalError);
  });
});

describe("assistantRequestOptions", () => {
  it("raises tiny max_tokens so thinking can't eat the whole budget", () => {
    assert.equal(assistantRequestOptions("claude-opus-5-5", 60).max_tokens, MIN_ASSISTANT_MAX_TOKENS);
  });
  it("keeps a larger requested cap", () => {
    assert.equal(assistantRequestOptions("claude-opus-5-5", 20000).max_tokens, 20000);
  });
  it("sends effort to models that accept it", () => {
    assert.deepEqual(assistantRequestOptions("claude-opus-5-5", 60).output_config, { effort: "low" });
    assert.deepEqual(assistantRequestOptions("claude-sonnet-5", 60, "medium").output_config, { effort: "medium" });
  });
  it("omits effort for Haiku 4.5, which rejects it", () => {
    assert.equal(assistantRequestOptions("claude-haiku-4-5", 50).output_config, undefined);
  });
});

describe("modelSupportsEffort", () => {
  it("accepts current models", () => {
    for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-5-20251101", "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5-1", "claude-mythos-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]) {
      assert.equal(modelSupportsEffort(m), true, m);
    }
  });
  it("rejects models known to 400 on effort", () => {
    for (const m of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-3-5-sonnet-20241022", "claude-opus-4-1", "claude-3-5-haiku-20241022"]) {
      assert.equal(modelSupportsEffort(m), false, m);
    }
  });
  it("passes unknown ids through", () => {
    assert.equal(modelSupportsEffort("my-gateway-alias"), true);
    assert.equal(modelSupportsEffort(null), true);
  });
});
