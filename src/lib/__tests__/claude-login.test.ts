import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  cleanCliOutput,
  extractLoginUrl,
  loginErrorMessage,
  looksLikeLoginSuccess,
  normalizeLoginCode,
  parseLoginCredentials,
} from "../providers/claude-login";

// What `claude auth login --claudeai` (2.1.x) prints without a TTY.
const STARTUP_OUTPUT =
  "Opening browser to sign in…\n" +
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile+user%3Ainference&code_challenge=xyz&code_challenge_method=S256&state=st\n" +
  "Paste code here if prompted > ";

describe("extractLoginUrl", () => {
  test("finds the authorize URL in the CLI's startup output", () => {
    const url = extractLoginUrl(STARTUP_OUTPUT);
    assert.ok(url?.startsWith("https://claude.com/cai/oauth/authorize?code=true"));
    assert.ok(url?.endsWith("state=st"));
  });

  test("ignores ANSI colour codes around the URL", () => {
    const url = extractLoginUrl("visit: \x1b[4mhttps://claude.ai/oauth/authorize?x=1\x1b[24m\n");
    assert.equal(url, "https://claude.ai/oauth/authorize?x=1");
  });

  test("returns null before the URL has been printed", () => {
    assert.equal(extractLoginUrl("Opening browser to sign in…\n"), null);
  });
});

describe("normalizeLoginCode", () => {
  test("accepts a code#state string and strips whitespace from copy/paste", () => {
    assert.deepEqual(normalizeLoginCode("  abc123#state456 \n"), { ok: true, code: "abc123#state456" });
    assert.deepEqual(normalizeLoginCode("abc\n123#state"), { ok: true, code: "abc123#state" });
  });

  test("accepts the callback page URL", () => {
    assert.deepEqual(
      normalizeLoginCode("https://platform.claude.com/oauth/code/callback?code=abc&state=def"),
      { ok: true, code: "abc#def" },
    );
  });

  test("rejects partial codes without contacting the CLI", () => {
    for (const bad of ["", "abc123", "abc#", "#def", "a#b#c", "https://platform.claude.com/oauth/code/callback?code=abc"]) {
      assert.equal(normalizeLoginCode(bad).ok, false, bad);
    }
  });
});

describe("parseLoginCredentials", () => {
  const good = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1 } });

  test("accepts a subscription login", () => {
    assert.equal(parseLoginCredentials(`${good}\n`), good);
  });

  test("rejects missing, malformed or incomplete credentials", () => {
    assert.equal(parseLoginCredentials(null), null);
    assert.equal(parseLoginCredentials("{"), null);
    assert.equal(parseLoginCredentials(JSON.stringify({})), null);
    assert.equal(parseLoginCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "a" } })), null);
  });
});

describe("CLI output after a code", () => {
  test("a rejected code yields the CLI's message without the re-printed prompt", () => {
    const out = "That doesn't look like the full code. Copy all of it, including the # in the middle.\nPaste code here if prompted > ";
    assert.equal(loginErrorMessage(out), "That doesn't look like the full code. Copy all of it, including the # in the middle.");
    assert.equal(looksLikeLoginSuccess(out), false);
  });

  test("falls back when the CLI printed nothing useful", () => {
    assert.equal(loginErrorMessage("\r\n\x1b[0m", "nope"), "nope");
  });

  test("recognises a success message", () => {
    assert.equal(looksLikeLoginSuccess("Login successful.\n"), true);
  });

  test("cleanCliOutput strips escapes and carriage returns", () => {
    assert.equal(cleanCliOutput("\x1b[32mok\x1b[0m\r\n"), "ok\n");
  });
});
