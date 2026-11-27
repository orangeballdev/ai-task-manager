import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAuthRequiredToggle,
  parseAuthRequired,
  checkPasskeyRemoval,
  checkPasswordLoginToggle,
  isApiPath,
  isPublicPath,
  isSecureRequest,
  isValidEmail,
  normalizeEmail,
  parseSignupsEnabled,
  passwordLoginAllowed,
  reenablePasswordAfterRemoval,
  safeNextPath,
} from "../auth/policy";
import { FailureLimiter } from "../auth/rate-limit";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../auth/password";

test("isPublicPath: sign-in pages and self-authenticating endpoints are public", () => {
  for (const p of [
    "/login",
    "/signup",
    "/api/auth/login",
    "/api/auth/signup",
    "/api/auth/config",
    "/api/auth/passkey/login/options",
    "/api/auth/passkey/login/verify",
    "/api/v1/tasks",
    "/api/v1/tasks/abc/start",
    "/api/llm/v1/chat/completions",
    "/api/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/api/mcp",
    "/api/oauth/token",
    "/api/oauth/register",
    "/api/oauth/revoke",
    "/api/webhooks/receive/my-hook",
    "/api/integrations/email/inbound",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/next.svg",
  ]) {
    assert.equal(isPublicPath(p), true, p);
  }
});

test("isPublicPath: everything else needs a session", () => {
  for (const p of [
    "/",
    "/tasks",
    "/settings/account",
    "/oauth/authorize",
    "/api/oauth/authorize",
    "/api/tasks",
    "/api/settings",
    "/api/settings/backup",
    "/api/auth/me",
    "/api/auth/events",
    "/api/auth/signups",
    "/api/auth/passkey/register/options",
    "/api/webhooks",
    "/api/webhooks/abc",
    "/api/integrations/email",
    "/api/mcp-tokens",
    "/api/mcpx",
    "/api/files/x.png", // static-looking names under /api are never public
    "/loginx",
  ]) {
    assert.equal(isPublicPath(p), false, p);
  }
});

test("isApiPath", () => {
  assert.equal(isApiPath("/api/tasks"), true);
  assert.equal(isApiPath("/api"), true);
  assert.equal(isApiPath("/apis"), false);
  assert.equal(isApiPath("/tasks"), false);
});

test("safeNextPath only allows same-site relative paths", () => {
  assert.equal(safeNextPath("/tasks/123?tab=logs"), "/tasks/123?tab=logs");
  assert.equal(safeNextPath("/oauth/authorize?client_id=x"), "/oauth/authorize?client_id=x");
  assert.equal(safeNextPath("https://evil.example"), "/");
  assert.equal(safeNextPath("//evil.example"), "/");
  assert.equal(safeNextPath("/\\evil.example"), "/");
  assert.equal(safeNextPath("/login"), "/");
  assert.equal(safeNextPath("/api/tasks"), "/");
  assert.equal(safeNextPath(undefined), "/");
});

test("email helpers", () => {
  assert.equal(normalizeEmail("  Someone@Example.COM "), "someone@example.com");
  assert.equal(normalizeEmail(42), "");
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("nope"), false);
  assert.equal(isValidEmail("a b@c.d"), false);
});

test("sign-ups default to disabled", () => {
  assert.equal(parseSignupsEnabled(undefined), false);
  assert.equal(parseSignupsEnabled(null), false);
  assert.equal(parseSignupsEnabled("false"), false);
  assert.equal(parseSignupsEnabled("true"), true);
});

test("password sign-in can only be disabled while a passkey exists", () => {
  const base = { passwordHash: "h", passwordLoginDisabled: false, passkeyCount: 0 };
  assert.equal(passwordLoginAllowed(base), true);
  assert.equal(passwordLoginAllowed({ ...base, passwordHash: null }), false);
  // Disabled with passkeys → refused.
  assert.equal(passwordLoginAllowed({ ...base, passwordLoginDisabled: true, passkeyCount: 1 }), false);
  // Disabled but no passkeys left → ignored, so the account isn't locked out.
  assert.equal(passwordLoginAllowed({ ...base, passwordLoginDisabled: true, passkeyCount: 0 }), true);

  assert.match(checkPasswordLoginToggle(base, true) ?? "", /passkey/);
  assert.equal(checkPasswordLoginToggle({ ...base, passkeyCount: 1 }, true), null);
  assert.equal(checkPasswordLoginToggle(base, false), null);
  assert.match(checkPasswordLoginToggle({ ...base, passwordHash: null }, false) ?? "", /password/);
});

test("removing the last passkey", () => {
  const s = { passwordHash: "h", passwordLoginDisabled: true, passkeyCount: 1 };
  assert.equal(checkPasskeyRemoval(s), null);
  assert.equal(reenablePasswordAfterRemoval(s), true);
  assert.equal(reenablePasswordAfterRemoval({ ...s, passkeyCount: 2 }), false);
  assert.equal(reenablePasswordAfterRemoval({ ...s, passwordLoginDisabled: false }), false);
  assert.match(checkPasskeyRemoval({ ...s, passwordHash: null }) ?? "", /only way/);
  assert.equal(checkPasskeyRemoval({ ...s, passwordHash: null, passkeyCount: 2 }), null);
});

test("isSecureRequest honours X-Forwarded-Proto", () => {
  assert.equal(isSecureRequest("https", "http:"), true);
  assert.equal(isSecureRequest("https, http", "http:"), true);
  assert.equal(isSecureRequest(null, "https:"), true);
  assert.equal(isSecureRequest(null, "http:"), false);
  assert.equal(isSecureRequest("http", "https:"), false);
});

test("FailureLimiter blocks after the limit and recovers after the window", () => {
  let now = 0;
  const lim = new FailureLimiter(() => now);
  const rule = { limit: 3, windowMs: 1000 };
  for (let i = 0; i < 3; i++) {
    assert.equal(lim.retryAfterMs("k", rule), 0);
    lim.recordFailure("k", rule);
    now += 100;
  }
  // Failures at t=0,100,200; now=300 → blocked until the first ages out at 1000.
  assert.equal(lim.retryAfterMs("k", rule), 700);
  assert.equal(lim.retryAfterMs("other", rule), 0);
  now = 1001;
  assert.equal(lim.retryAfterMs("k", rule), 0);
  lim.recordFailure("k", rule);
  lim.clear("k");
  assert.equal(lim.retryAfterMs("k", rule), 0);
});

test("password hashing round-trips and rejects wrong passwords", async () => {
  const h = await hashPassword("correct horse");
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
  assert.equal(await verifyPassword("x", null), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

test("the seeded owner password hash in the migration verifies as 'changeme'", async () => {
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const sql = readFileSync(join(__dirname, "../../../prisma/migrations/20261114120000_add_auth/migration.sql"), "utf8");
  const hash = /'(scrypt\$[^']+)'/.exec(sql)?.[1];
  assert.ok(hash);
  assert.equal(await verifyPassword("changeme", hash), true);
  assert.match(sql, /admin@example\.com/);
});

test("validatePasswordStrength", () => {
  assert.equal(validatePasswordStrength("changeme"), null);
  assert.match(validatePasswordStrength("short") ?? "", /at least 8/);
  assert.match(validatePasswordStrength(undefined) ?? "", /at least 8/);
});

test("parseAuthRequired defaults to off", () => {
  assert.equal(parseAuthRequired(undefined), false);
  assert.equal(parseAuthRequired(null), false);
  assert.equal(parseAuthRequired(""), false);
  assert.equal(parseAuthRequired("false"), false);
  assert.equal(parseAuthRequired("TRUE"), false);
  assert.equal(parseAuthRequired("true"), true);
});

test("checkAuthRequiredToggle only lets a signed-in user flip the switch", () => {
  assert.match(checkAuthRequiredToggle(true, false) ?? "", /Sign in/);
  assert.ok(checkAuthRequiredToggle(false, false));
  assert.equal(checkAuthRequiredToggle(true, true), null);
  assert.equal(checkAuthRequiredToggle(false, true), null);
});

test("the auth_required migration leaves fresh installs with sign-in off", async () => {
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const sql = readFileSync(
    join(__dirname, "../../../prisma/migrations/20261127180000_add_auth_required_setting/migration.sql"),
    "utf8",
  );
  // Only inserted conditionally — never unconditionally switched on.
  assert.match(sql, /'auth_required', 'true'\s+WHERE EXISTS/);
});
