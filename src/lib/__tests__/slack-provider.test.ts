/**
 * Unit tests for the Slack bot's provider fallback rules.
 *
 * The scenario these exist for: the Slack integration (or a stored task proposal) pins a
 * provider by id, that provider is later disabled, and the bot must keep working by using
 * another enabled provider instead of failing with "no provider configured".
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/slack-provider.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  modelFitsProvider,
  modelVendor,
  pickProposalModel,
  pickProposalProvider,
  providerOptionLabel,
  providerVendor,
  resolveConfiguredModel,
} from "../slack-provider.js";

const NOW = new Date("2025-01-01T12:00:00Z");
const LATER = new Date("2025-01-01T13:00:00Z");
const EARLIER = new Date("2025-01-01T11:00:00Z");

function provider(over: Partial<Parameters<typeof providerOptionLabel>[0]> & { id: string }) {
  return {
    name: over.id,
    type: "api",
    isEnabled: true,
    isDefault: false,
    throttledUntil: null,
    ...over,
  };
}

describe("pickProposalProvider", () => {
  it("uses the requested provider when it is enabled", () => {
    const providers = [provider({ id: "a" }), provider({ id: "b" })];
    const pick = pickProposalProvider(providers, "b", NOW);
    assert.equal(pick.provider?.id, "b");
    assert.equal(pick.source, "preferred");
    assert.equal(pick.fellBack, false);
  });

  it("falls back to another enabled provider when the requested one is disabled", () => {
    const providers = [provider({ id: "disabled", isEnabled: false }), provider({ id: "live" })];
    const pick = pickProposalProvider(providers, "disabled", NOW);
    assert.equal(pick.provider?.id, "live");
    assert.equal(pick.fellBack, true);
  });

  it("falls back when the requested provider no longer exists", () => {
    const pick = pickProposalProvider([provider({ id: "live" })], "deleted-id", NOW);
    assert.equal(pick.provider?.id, "live");
    assert.equal(pick.fellBack, true);
  });

  it("prefers the default provider when falling back", () => {
    const providers = [
      provider({ id: "first" }),
      provider({ id: "default", isDefault: true }),
    ];
    const pick = pickProposalProvider(providers, "disabled", NOW);
    assert.equal(pick.provider?.id, "default");
    assert.equal(pick.source, "default");
  });

  it("skips a throttled default when falling back", () => {
    const providers = [
      provider({ id: "default", isDefault: true, throttledUntil: LATER }),
      provider({ id: "free" }),
    ];
    const pick = pickProposalProvider(providers, null, NOW);
    assert.equal(pick.provider?.id, "free");
    assert.equal(pick.fellBack, false, "nothing was requested, so nothing was substituted");
  });

  it("keeps an explicitly requested provider that is only rate-limited", () => {
    const providers = [
      provider({ id: "chosen", throttledUntil: LATER }),
      provider({ id: "other" }),
    ];
    const pick = pickProposalProvider(providers, "chosen", NOW);
    assert.equal(pick.provider?.id, "chosen", "a throttle expires; the task runs later anyway");
    assert.equal(pick.fellBack, false);
  });

  it("treats an expired throttle as usable", () => {
    const providers = [provider({ id: "recovered", throttledUntil: EARLIER })];
    const pick = pickProposalProvider(providers, null, NOW);
    assert.equal(pick.provider?.id, "recovered");
  });

  it("still offers a provider when every enabled one is throttled", () => {
    const providers = [
      provider({ id: "a", throttledUntil: LATER }),
      provider({ id: "b", isDefault: true, throttledUntil: LATER }),
    ];
    const pick = pickProposalProvider(providers, null, NOW);
    assert.equal(pick.provider?.id, "b");
  });

  it("never returns a disabled provider, even as the only one", () => {
    const pick = pickProposalProvider([provider({ id: "off", isEnabled: false })], "off", NOW);
    assert.equal(pick.provider, null);
    assert.equal(pick.source, null);
    assert.equal(pick.fellBack, true);
  });

  it("returns null when there are no providers at all", () => {
    const pick = pickProposalProvider([], null, NOW);
    assert.equal(pick.provider, null);
    assert.equal(pick.fellBack, false);
  });
});

describe("providerOptionLabel", () => {
  it("flags rate-limited providers in the menu", () => {
    assert.equal(providerOptionLabel(provider({ id: "x", name: "Work", throttledUntil: LATER }), NOW), "Work (rate-limited)");
  });

  it("leaves usable providers alone", () => {
    assert.equal(providerOptionLabel(provider({ id: "x", name: "Work" }), NOW), "Work");
    assert.equal(providerOptionLabel(provider({ id: "x", name: "Work", throttledUntil: EARLIER }), NOW), "Work");
  });
});

describe("modelVendor / providerVendor / modelFitsProvider", () => {
  it("recognises the obvious model families", () => {
    assert.equal(modelVendor("claude-sonnet-4-5"), "anthropic");
    assert.equal(modelVendor("gpt-4o"), "openai");
    assert.equal(modelVendor("o3-mini"), "openai");
    assert.equal(modelVendor("chatgpt-4o-latest"), "openai");
    assert.equal(modelVendor("my-custom-deployment"), null);
    assert.equal(modelVendor(undefined), null);
    assert.equal(modelVendor(""), null);
  });

  it("maps provider types to vendors", () => {
    assert.equal(providerVendor("openai"), "openai");
    assert.equal(providerVendor("api"), "anthropic");
    assert.equal(providerVendor("cli"), "anthropic");
    assert.equal(providerVendor("claude-pki"), "anthropic");
  });

  it("rejects a model from the other vendor", () => {
    assert.equal(modelFitsProvider("gpt-4o", "api"), false);
    assert.equal(modelFitsProvider("claude-sonnet-4-5", "openai"), false);
  });

  it("accepts matching and unrecognised models", () => {
    assert.equal(modelFitsProvider("gpt-4o", "openai"), true);
    assert.equal(modelFitsProvider("claude-sonnet-4-5", "cli"), true);
    assert.equal(modelFitsProvider("internal-proxy-model", "api"), true);
    assert.equal(modelFitsProvider(null, "api"), true);
  });
});

describe("pickProposalModel", () => {
  const anthropic = [
    { id: "claude-sonnet-4-5", label: "Sonnet" },
    { id: "claude-opus-4-1", label: "Opus" },
  ];

  it("keeps the chosen model when the provider offers it", () => {
    assert.equal(pickProposalModel("claude-opus-4-1", anthropic, "api"), "claude-opus-4-1");
  });

  it("falls back to the provider's first model when the chosen one is from another vendor", () => {
    assert.equal(pickProposalModel("gpt-4o", anthropic, "api"), "claude-sonnet-4-5");
  });

  it("falls back when the provider no longer lists the chosen model", () => {
    assert.equal(pickProposalModel("claude-2", anthropic, "api"), "claude-sonnet-4-5");
  });

  it("keeps a plausible custom model when no list is available", () => {
    assert.equal(pickProposalModel("internal-proxy-model", [], "api"), "internal-proxy-model");
    assert.equal(pickProposalModel("gpt-4o", [], "api"), "");
  });

  it("returns the provider default when nothing was chosen", () => {
    assert.equal(pickProposalModel(undefined, anthropic, "api"), "claude-sonnet-4-5");
    assert.equal(pickProposalModel("   ", anthropic, "api"), "claude-sonnet-4-5");
    assert.equal(pickProposalModel(undefined, [], "api"), "");
  });
});

describe("resolveConfiguredModel", () => {
  it("keeps the configured model when it fits the resolved provider", () => {
    assert.equal(resolveConfiguredModel("claude-opus-4-1", { type: "api", model: "claude-sonnet-4-5" }), "claude-opus-4-1");
  });

  it("drops a model belonging to another vendor after a fallback", () => {
    assert.equal(resolveConfiguredModel("gpt-4o", { type: "api", model: "claude-sonnet-4-5" }), "claude-sonnet-4-5");
    assert.equal(resolveConfiguredModel("claude-sonnet-4-5", { type: "openai", model: "gpt-4o" }), "gpt-4o");
  });

  it("uses the provider's own model when nothing is configured", () => {
    assert.equal(resolveConfiguredModel(undefined, { type: "api", model: "claude-sonnet-4-5" }), "claude-sonnet-4-5");
    assert.equal(resolveConfiguredModel(undefined, { type: "api", model: null }), null);
  });

  it("returns null without a provider", () => {
    assert.equal(resolveConfiguredModel("gpt-4o", null), null);
  });
});
