import { test } from "node:test";
import assert from "node:assert/strict";
import { apiKeyProviderValue, parseApiKeyProvider, SMART_PROVIDER_VALUE } from "../api-key-provider";

test("parseApiKeyProvider treats absent/null/blank as the default chain", () => {
  for (const v of [undefined, null, "", "   "]) {
    assert.deepEqual(parseApiKeyProvider(v), { aiProviderId: null, useSmartProvider: false });
  }
});

test("parseApiKeyProvider maps 'smart' to smart pick", () => {
  assert.deepEqual(parseApiKeyProvider(SMART_PROVIDER_VALUE), { aiProviderId: null, useSmartProvider: true });
  assert.deepEqual(parseApiKeyProvider(" smart "), { aiProviderId: null, useSmartProvider: true });
});

test("parseApiKeyProvider pins any other string as a provider id", () => {
  assert.deepEqual(parseApiKeyProvider(" prov_123 "), { aiProviderId: "prov_123", useSmartProvider: false });
});

test("parseApiKeyProvider rejects non-string values", () => {
  assert.equal(parseApiKeyProvider(42), null);
  assert.equal(parseApiKeyProvider(true), null);
  assert.equal(parseApiKeyProvider({ id: "x" }), null);
});

test("apiKeyProviderValue round-trips through parseApiKeyProvider", () => {
  for (const v of ["", SMART_PROVIDER_VALUE, "prov_123"]) {
    assert.equal(apiKeyProviderValue(parseApiKeyProvider(v)!), v);
  }
  // Smart wins if a row somehow has both set.
  assert.equal(apiKeyProviderValue({ aiProviderId: "prov_1", useSmartProvider: true }), SMART_PROVIDER_VALUE);
});
