/**
 * Unit tests for the pure half of MCP OAuth (src/lib/mcp/oauth.ts).
 *
 * Run with:
 *   npx tsx --test src/lib/__tests__/mcp-oauth.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  accessFromScope,
  authorizationServerMetadata,
  buildRedirect,
  checkAuthorizeRequest,
  parseClientRegistration,
  parseTokenRequestBody,
  pkceChallengeFor,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  readAuthorizeParams,
  readClientCredentials,
  redirectUriMatches,
  resourceMatches,
  scopeForAccess,
  tokenResponse,
  unknownScopes,
  validateRedirectUri,
  verifyPkce,
  wwwAuthenticateHeader,
  type AuthorizeParams,
  type KnownClient,
} from "../mcp/oauth";
import { mcpOAuthClientSnippets } from "../mcp/client-config";

const ORIGIN = "https://tasks.example.com";
const VERIFIER = "dBjftJeZ4CVP-mJ92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "ngF5GsXcbwljx6u133FFr3Xht9xooA_DuaX_3QwODtc"; // base64url(sha256(VERIFIER))

describe("metadata", () => {
  it("points the protected resource at this origin as its authorization server", () => {
    const m = protectedResourceMetadata(`${ORIGIN}/`);
    assert.equal(m.resource, `${ORIGIN}/api/mcp`);
    assert.deepEqual(m.authorization_servers, [ORIGIN]);
  });

  it("advertises the endpoints, PKCE S256 and both grant types", () => {
    const m = authorizationServerMetadata(ORIGIN);
    assert.equal(m.issuer, ORIGIN);
    assert.equal(m.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
    assert.equal(m.token_endpoint, `${ORIGIN}/api/oauth/token`);
    assert.equal(m.registration_endpoint, `${ORIGIN}/api/oauth/register`);
    assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
    assert.ok(m.grant_types_supported.includes("refresh_token"));
    assert.ok(m.token_endpoint_auth_methods_supported.includes("none"));
  });

  it("names the resource metadata URL in the 401 header", () => {
    const h = wwwAuthenticateHeader(ORIGIN);
    assert.match(h, /^Bearer /);
    assert.ok(h.includes(`resource_metadata="${protectedResourceMetadataUrl(ORIGIN)}"`));
    assert.equal(protectedResourceMetadataUrl(ORIGIN), `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`);
    assert.ok(!h.includes("error="));
  });

  it("adds invalid_token and strips quotes from the description", () => {
    const h = wwwAuthenticateHeader(ORIGIN, { code: "invalid_token", description: 'bad "token"' });
    assert.ok(h.includes('error="invalid_token"'));
    assert.ok(h.includes('error_description="bad token"'));
  });
});

describe("PKCE", () => {
  it("computes the S256 challenge", () => {
    assert.equal(pkceChallengeFor(VERIFIER), CHALLENGE);
    assert.equal(verifyPkce(VERIFIER, CHALLENGE), true);
  });

  it("rejects a wrong or malformed verifier", () => {
    assert.equal(verifyPkce(VERIFIER.replace("d", "e"), CHALLENGE), false);
    assert.equal(verifyPkce("short", pkceChallengeFor("short")), false);
  });
});

describe("scopes", () => {
  it("maps scopes to access levels and back", () => {
    assert.equal(accessFromScope("mcp:read mcp:write"), "write");
    assert.equal(accessFromScope("mcp:read"), "read");
    assert.equal(accessFromScope(null), "read");
    assert.equal(scopeForAccess("write"), "mcp:read mcp:write");
    assert.equal(scopeForAccess("read"), "mcp:read");
  });

  it("lists unknown scopes", () => {
    assert.deepEqual(unknownScopes("mcp:read openid  profile"), ["openid", "profile"]);
    assert.deepEqual(unknownScopes(undefined), []);
  });
});

describe("redirect URIs", () => {
  it("allows https, loopback http and private-use schemes", () => {
    assert.equal(validateRedirectUri("https://claude.ai/api/mcp/auth_callback"), null);
    assert.equal(validateRedirectUri("http://localhost:33418/callback"), null);
    assert.equal(validateRedirectUri("http://127.0.0.1:1455/auth/callback"), null);
    assert.equal(validateRedirectUri("http://[::1]:8080/cb"), null);
    assert.equal(validateRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback"), null);
  });

  it("rejects non-loopback http, dangerous schemes, fragments and garbage", () => {
    assert.ok(validateRedirectUri("http://evil.example.com/cb"));
    assert.ok(validateRedirectUri("javascript:alert(1)"));
    assert.ok(validateRedirectUri("data:text/html,hi"));
    assert.ok(validateRedirectUri("https://ok.example.com/cb#frag"));
    assert.ok(validateRedirectUri("not a url"));
  });

  it("matches exactly, or on any port for loopback http", () => {
    const reg = ["http://127.0.0.1:5000/callback", "https://app.example.com/cb"];
    assert.equal(redirectUriMatches(reg, "https://app.example.com/cb"), true);
    assert.equal(redirectUriMatches(reg, "http://127.0.0.1:61234/callback"), true);
    assert.equal(redirectUriMatches(reg, "http://127.0.0.1:61234/other"), false);
    assert.equal(redirectUriMatches(reg, "http://localhost:5000/callback"), false);
    assert.equal(redirectUriMatches(reg, "https://app.example.com:8443/cb"), false);
    assert.equal(redirectUriMatches(reg, "https://app.example.com/cb2"), false);
  });

  it("builds the redirect back, skipping undefined params", () => {
    const url = new URL(buildRedirect("http://127.0.0.1:5000/cb?x=1", { code: "abc", state: undefined, iss: ORIGIN }));
    assert.equal(url.searchParams.get("x"), "1");
    assert.equal(url.searchParams.get("code"), "abc");
    assert.equal(url.searchParams.has("state"), false);
    assert.equal(url.searchParams.get("iss"), ORIGIN);
  });

  it("accepts the MCP endpoint or bare origin as resource", () => {
    assert.equal(resourceMatches(ORIGIN, undefined), true);
    assert.equal(resourceMatches(ORIGIN, `${ORIGIN}/api/mcp`), true);
    assert.equal(resourceMatches(ORIGIN, `${ORIGIN}/api/mcp/`), true);
    assert.equal(resourceMatches(ORIGIN, `${ORIGIN}/`), true);
    assert.equal(resourceMatches(ORIGIN, "https://other.example.com/api/mcp"), false);
  });
});

describe("parseClientRegistration", () => {
  it("accepts a typical public native client", () => {
    const r = parseClientRegistration({
      client_name: "Claude Code (task-manager)",
      redirect_uris: ["http://localhost:4242/callback", "http://localhost:4242/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.client.name, "Claude Code (task-manager)");
    assert.deepEqual(r.client.redirectUris, ["http://localhost:4242/callback"]);
    assert.equal(r.client.tokenEndpointAuthMethod, "none");
  });

  it("defaults the name and auth method", () => {
    const r = parseClientRegistration({ redirect_uris: ["https://x.example.com/cb"] });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.client.name, "MCP client");
    assert.equal(r.client.tokenEndpointAuthMethod, "none");
    assert.equal(r.client.clientUri, null);
  });

  it("rejects bad bodies", () => {
    assert.equal(parseClientRegistration(null).ok, false);
    assert.equal(parseClientRegistration([]).ok, false);
    const noUris = parseClientRegistration({ client_name: "x" });
    assert.ok(!noUris.ok && noUris.error === "invalid_redirect_uri");
    const badUri = parseClientRegistration({ redirect_uris: ["http://evil.example.com/cb"] });
    assert.ok(!badUri.ok && badUri.error === "invalid_redirect_uri");
    const badMethod = parseClientRegistration({ redirect_uris: ["https://x.example.com/cb"], token_endpoint_auth_method: "private_key_jwt" });
    assert.ok(!badMethod.ok && badMethod.error === "invalid_client_metadata");
    const badGrant = parseClientRegistration({ redirect_uris: ["https://x.example.com/cb"], grant_types: ["client_credentials"] });
    assert.ok(!badGrant.ok);
    const tooMany = parseClientRegistration({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://x.example.com/${i}`) });
    assert.ok(!tooMany.ok);
  });
});

describe("checkAuthorizeRequest", () => {
  const client: KnownClient = { id: "mcpc_1", name: "Codex", redirectUris: ["http://127.0.0.1:1455/auth/callback"] };
  const base = (over: Partial<Record<string, string>> = {}): AuthorizeParams =>
    readAuthorizeParams((k) =>
      ({
        response_type: "code",
        client_id: "mcpc_1",
        redirect_uri: "http://127.0.0.1:50000/auth/callback",
        state: "xyz",
        scope: "mcp:read mcp:write",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        resource: `${ORIGIN}/api/mcp`,
        ...over,
      })[k],
    );

  it("accepts a valid request and reads the requested access", () => {
    const r = checkAuthorizeRequest(base(), client, ORIGIN);
    assert.deepEqual(r, { kind: "ok", redirectUri: "http://127.0.0.1:50000/auth/callback", requestedAccess: "write" });
  });

  it("falls back to the only registered redirect URI", () => {
    const r = checkAuthorizeRequest(base({ redirect_uri: "" }), client, ORIGIN);
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.redirectUri, client.redirectUris[0]);
  });

  it("never redirects for unknown clients or unregistered redirect URIs", () => {
    assert.equal(checkAuthorizeRequest(base(), null, ORIGIN).kind, "fatal");
    assert.equal(checkAuthorizeRequest(base({ client_id: "" }), client, ORIGIN).kind, "fatal");
    assert.equal(checkAuthorizeRequest(base({ redirect_uri: "https://evil.example.com/cb" }), client, ORIGIN).kind, "fatal");
  });

  it("redirects protocol errors back to the client", () => {
    const cases: [Partial<Record<string, string>>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: "" }, "invalid_request"],
      [{ code_challenge: "too-short" }, "invalid_request"],
      [{ resource: "https://other.example.com/api/mcp" }, "invalid_target"],
    ];
    for (const [over, error] of cases) {
      const r = checkAuthorizeRequest(base(over), client, ORIGIN);
      assert.equal(r.kind, "redirect_error", JSON.stringify(over));
      if (r.kind === "redirect_error") assert.equal(r.error, error);
    }
  });
});

describe("token endpoint helpers", () => {
  it("reads client credentials from Basic auth, else the body", () => {
    const basic = `Basic ${Buffer.from("mcpc_1:s%3Acret").toString("base64")}`;
    assert.deepEqual(readClientCredentials(basic, {}), { clientId: "mcpc_1", clientSecret: "s:cret" });
    assert.deepEqual(readClientCredentials(null, { client_id: "mcpc_2" }), { clientId: "mcpc_2", clientSecret: null });
  });

  it("parses form and JSON bodies", () => {
    assert.deepEqual(parseTokenRequestBody("application/x-www-form-urlencoded", "grant_type=refresh_token&refresh_token=a%2Bb"), {
      grant_type: "refresh_token",
      refresh_token: "a+b",
    });
    assert.deepEqual(parseTokenRequestBody("application/json", '{"grant_type":"authorization_code","n":1}'), {
      grant_type: "authorization_code",
    });
    assert.deepEqual(parseTokenRequestBody("application/json", "{oops"), {});
  });

  it("shapes the token response", () => {
    const r = tokenResponse("tm_mcp_a", "tm_mcpr_b", "read");
    assert.equal(r.token_type, "Bearer");
    assert.equal(r.expires_in, 3600);
    assert.equal(r.scope, "mcp:read");
  });
});

describe("OAuth client snippets", () => {
  it("configure only the URL — no token", () => {
    const snippets = mcpOAuthClientSnippets(`${ORIGIN}/`);
    assert.ok(snippets.some((s) => s.id === "codex"));
    assert.ok(snippets.some((s) => s.id === "claude-code"));
    for (const s of snippets) {
      assert.ok(s.code.includes(`${ORIGIN}/api/mcp`), s.id);
      assert.ok(!s.code.includes("tm_mcp_"), s.id);
    }
  });
});
