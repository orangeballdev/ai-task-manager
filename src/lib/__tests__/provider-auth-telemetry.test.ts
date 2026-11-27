import { test } from "node:test";
import assert from "node:assert/strict";
import {
  healthCheckAuthFailure,
  providerAuthFailureAttributes,
  providerAuthFailureBody,
  sanitizeAuthReason,
} from "../provider-auth-telemetry";

const provider = { id: "p1", name: "Work Max", type: "cli" };

test("attributes identify the provider, source and task", () => {
  const attrs = providerAuthFailureAttributes({
    provider, source: "task_run", taskId: "t1",
    reason: "Failed to authenticate: OAuth session expired and could not be refreshed",
  });
  assert.equal(attrs["ctm.provider.id"], "p1");
  assert.equal(attrs["ctm.provider.name"], "Work Max");
  assert.equal(attrs["ctm.provider.type"], "cli");
  assert.equal(attrs["gen_ai.provider.name"], "anthropic");
  assert.equal(attrs["ctm.provider.auth.source"], "task_run");
  assert.equal(attrs["error.type"], "authentication");
  assert.equal(attrs["ctm.task.id"], "t1");
  assert.match(String(attrs["ctm.provider.auth.reason"]), /OAuth session expired/);
});

test("optional fields are left out when absent", () => {
  const attrs = providerAuthFailureAttributes({ provider: { ...provider, type: "codex-cli" }, source: "health_check" });
  assert.equal(attrs["gen_ai.provider.name"], "openai");
  assert.ok(!("ctm.task.id" in attrs));
  assert.ok(!("ctm.provider.auth.reason" in attrs));
});

test("reason is redacted and clipped", () => {
  const leaked = sanitizeAuthReason("Incorrect API key provided: sk-proj-abcdefghijklmnop1234");
  assert.ok(leaked && !leaked.includes("abcdefghijklmnop"));
  assert.equal(sanitizeAuthReason("x".repeat(2000))!.length, 500);
  assert.equal(sanitizeAuthReason("   "), undefined);
});

test("body names the provider", () => {
  assert.equal(
    providerAuthFailureBody({ provider, source: "credential_check", reason: "401 Unauthorized" }),
    'AI provider "Work Max" (cli) credentials are expired or invalid: 401 Unauthorized',
  );
});

test("healthCheckAuthFailure only reports credential problems", () => {
  assert.equal(healthCheckAuthFailure({ authStatus: "ok" }), null);
  assert.equal(healthCheckAuthFailure({ authStatus: "missing", authError: "No API key configured" }), null);
  assert.equal(healthCheckAuthFailure({ authStatus: "error", authError: "Unknown provider type: foo" }), null);
  assert.equal(healthCheckAuthFailure({ authStatus: "error", authError: "Failed to write Codex auth.json: EACCES" }), null);
  assert.equal(healthCheckAuthFailure({ authStatus: "error", authError: "Codex login has expired." }), "Codex login has expired.");
  assert.equal(healthCheckAuthFailure({ authStatus: "error" }), "Authentication failed");
});
