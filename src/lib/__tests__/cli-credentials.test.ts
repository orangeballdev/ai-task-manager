import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decideCredentialWrite } from "../providers/cli-credentials";

// Stand-in for `extractExpiresAt` / `extractCodexExpiresAt`: the credential blobs in these
// tests are just `{"expiresAt": n}` so the rules under test stay readable.
const expiresAtOf = (json: string) => {
  try {
    return (JSON.parse(json) as { expiresAt?: number }).expiresAt ?? 0;
  } catch {
    return 0;
  }
};

const creds = (expiresAt: number, account = "a") => JSON.stringify({ expiresAt, account });

describe("decideCredentialWrite", () => {
  test("does nothing when the provider has no stored credentials", () => {
    const decision = decideCredentialWrite({
      providerId: "p1",
      dbCredentials: null,
      diskCredentials: creds(100),
      expiresAtOf,
    });
    assert.equal(decision.write, false);
  });

  test("writes when the config dir is empty", () => {
    const decision = decideCredentialWrite({
      providerId: "p1",
      dbCredentials: creds(100),
      diskCredentials: null,
      expiresAtOf,
    });
    assert.equal(decision.write, true);
  });

  test("keeps a fresher token this same provider's CLI rotated", () => {
    const decision = decideCredentialWrite({
      providerId: "p1",
      dbCredentials: creds(100),
      diskCredentials: creds(200),
      owner: "p1",
      expiresAtOf,
    });
    assert.equal(decision.write, false);
  });

  test("writes over its own dir when the stored copy is at least as new", () => {
    const decision = decideCredentialWrite({
      providerId: "p1",
      dbCredentials: creds(200),
      diskCredentials: creds(200),
      owner: "p1",
      expiresAtOf,
    });
    assert.equal(decision.write, true);
  });

  // The bug this module exists for: two connections sharing ~/.claude, where the *other*
  // one's login is fresher. Freshness must not win over identity, or the task silently runs
  // on the account the user switched off.
  test("overwrites a dir owned by another provider even when its token is newer", () => {
    const decision = decideCredentialWrite({
      providerId: "p1",
      dbCredentials: creds(100, "mine"),
      diskCredentials: creds(999, "theirs"),
      owner: "p2",
      expiresAtOf,
    });
    assert.equal(decision.write, true);
  });

  test("overwrites an unattributed dir whose contents are another provider's stored login", () => {
    const theirs = creds(999, "theirs");
    const decision = decideCredentialWrite({
      providerId: "p1",
      dbCredentials: creds(100, "mine"),
      diskCredentials: theirs,
      owner: null,
      otherProviderCredentials: [null, theirs],
      expiresAtOf,
    });
    assert.equal(decision.write, true);
  });

  test("falls back to the freshness guard on an unattributed dir it can't attribute", () => {
    const decision = decideCredentialWrite({
      providerId: "p1",
      dbCredentials: creds(100),
      diskCredentials: creds(200),
      owner: null,
      otherProviderCredentials: [creds(50, "someone-else")],
      expiresAtOf,
    });
    assert.equal(decision.write, false);
  });

  test("treats an unreadable expiry as unknown rather than expired", () => {
    const decision = decideCredentialWrite({
      providerId: "p1",
      dbCredentials: creds(100),
      diskCredentials: "not json",
      owner: "p1",
      expiresAtOf,
    });
    // Unknown (0) is not newer than 100, so the stored copy is written.
    assert.equal(decision.write, true);
  });

  test("ignores whitespace-only credentials on either side", () => {
    assert.equal(
      decideCredentialWrite({ providerId: "p1", dbCredentials: "   ", diskCredentials: creds(1), expiresAtOf }).write,
      false,
    );
    assert.equal(
      decideCredentialWrite({ providerId: "p1", dbCredentials: creds(1), diskCredentials: "  \n ", expiresAtOf }).write,
      true,
    );
  });
});
