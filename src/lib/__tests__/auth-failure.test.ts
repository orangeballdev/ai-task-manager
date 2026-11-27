import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectProviderAuthFailure, tailLines } from "../auth-failure";

describe("detectProviderAuthFailure", () => {
  it("recognises the Claude CLI's expired OAuth session", () => {
    const line = "Failed to authenticate: OAuth session expired and could not be refreshed";
    assert.equal(detectProviderAuthFailure(`some noise\n${line}\n`), line);
  });

  it("recognises API-level authentication errors", () => {
    assert.ok(detectProviderAuthFailure('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'));
    assert.ok(detectProviderAuthFailure("Invalid API key · Please run /login"));
    assert.ok(detectProviderAuthFailure("OAuth token has expired"));
    assert.ok(detectProviderAuthFailure("Your credentials have expired"));
  });

  it("ignores an agent merely talking about auth", () => {
    assert.equal(detectProviderAuthFailure("Added handling for 401 responses in the API client"), null);
    assert.equal(detectProviderAuthFailure("fix: refresh the session when it expires"), null);
    assert.equal(detectProviderAuthFailure("Unauthorized users are redirected to /login"), null);
    assert.equal(detectProviderAuthFailure(""), null);
  });
});

describe("tailLines", () => {
  it("keeps only the last non-empty lines", () => {
    assert.equal(tailLines(["a\nb", "", "c\n\nd"], 2), "c\nd");
  });
});
