import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_USER_MONITORING_HOST,
  USER_MONITORING_KEYS as K,
  resolveUserMonitoring,
  validateUserMonitoringHost,
  validateUserMonitoringKey,
} from "../user-monitoring";

test("user monitoring is off by default", () => {
  assert.equal(resolveUserMonitoring({}), null);
});

test("a saved key alone doesn't turn monitoring on", () => {
  assert.equal(resolveUserMonitoring({ [K.apiKey]: "lsk_abc" }), null);
});

test("switching it on without a key stays off", () => {
  assert.equal(resolveUserMonitoring({ [K.enabled]: "true" }), null);
  assert.equal(resolveUserMonitoring({ [K.enabled]: "true", [K.apiKey]: "   " }), null);
});

test("enabled with a key uses the default host", () => {
  assert.deepEqual(resolveUserMonitoring({ [K.enabled]: "true", [K.apiKey]: " lsk_abc " }), {
    apiKey: "lsk_abc",
    host: DEFAULT_USER_MONITORING_HOST,
  });
});

test("a custom host overrides the default", () => {
  assert.deepEqual(
    resolveUserMonitoring({ [K.enabled]: "true", [K.apiKey]: "lsk_abc", [K.host]: "https://ingest.example.com" }),
    { apiKey: "lsk_abc", host: "https://ingest.example.com" },
  );
});

test("switching it off wins over a saved key", () => {
  assert.equal(resolveUserMonitoring({ [K.enabled]: "false", [K.apiKey]: "lsk_abc" }), null);
});

test("key validation", () => {
  assert.equal(validateUserMonitoringKey("lsk_abc123"), null);
  assert.match(validateUserMonitoringKey("")!, /Enter/);
  assert.match(validateUserMonitoringKey("sk-abc")!, /lsk_/);
  assert.match(validateUserMonitoringKey("lsk_a b")!, /spaces/);
});

test("host validation", () => {
  assert.equal(validateUserMonitoringHost(""), null);
  assert.equal(validateUserMonitoringHost("https://ingest.obistack.com"), null);
  assert.match(validateUserMonitoringHost("ingest.obistack.com")!, /full URL/);
  assert.match(validateUserMonitoringHost("ftp://x.example.com")!, /http/);
});
