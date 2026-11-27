// OAuth 2.1 for the MCP endpoint (/api/mcp) — the pure half: metadata documents, PKCE,
// redirect-URI and scope rules, request validation. No DB access, so it's unit-tested
// (src/lib/__tests__/mcp-oauth.test.ts); persistence lives in src/lib/mcp/oauth-store.ts.
//
// This implements the MCP authorization spec so clients such as Claude Code, Claude
// Desktop (custom connectors) and Codex can connect with nothing but the server URL:
//
//   1. /api/mcp answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`.
//   2. The client reads the protected-resource metadata (RFC 9728) at
//      /.well-known/oauth-protected-resource[/api/mcp], which names this app as the
//      authorization server, then its metadata (RFC 8414) at
//      /.well-known/oauth-authorization-server.
//   3. It registers itself (RFC 7591 dynamic client registration, POST /api/oauth/register).
//   4. It opens /oauth/authorize in the browser (authorization code + PKCE S256); the user
//      approves on a consent page and picks read-only or read & write access.
//   5. It swaps the code for tokens at POST /api/oauth/token and refreshes them there.
//
// An OAuth access token *is* an MCP token (`tm_mcp_…`, stored as a hashed McpToken row with
// an expiry), so /api/mcp authenticates it exactly like a token from Settings → MCP, and the
// grant shows up — and can be revoked or downgraded — on that page.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { McpAccess } from "./tokens";

export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, sliding (rotated on use)
export const OAUTH_CODE_TTL_SECONDS = 10 * 60;

export const OAUTH_CLIENT_ID_PREFIX = "mcpc_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "tm_mcpr_";
export const OAUTH_CLIENT_SECRET_PREFIX = "tm_mcps_";

export const SCOPE_READ = "mcp:read";
export const SCOPE_WRITE = "mcp:write";
export const OAUTH_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

export const MCP_RESOURCE_PATH = "/api/mcp";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/api/oauth/token";
export const REGISTER_PATH = "/api/oauth/register";
export const REVOKE_PATH = "/api/oauth/revoke";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";
const AUTH_METHODS: readonly TokenEndpointAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export function mcpResourceUrl(origin: string): string {
  return `${trimOrigin(origin)}${MCP_RESOURCE_PATH}`;
}

/** Where /api/mcp's 401 points clients (the path-suffixed form from RFC 9728 §3.1). */
export function protectedResourceMetadataUrl(origin: string): string {
  return `${trimOrigin(origin)}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_RESOURCE_PATH}`;
}

/** RFC 9728 protected resource metadata for /api/mcp. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [trimOrigin(origin)],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "AI Task Manager",
    resource_documentation: `${trimOrigin(origin)}/docs/mcp`,
  };
}

/** RFC 8414 authorization server metadata. The issuer is the app's origin. */
export function authorizationServerMetadata(origin: string) {
  const o = trimOrigin(origin);
  return {
    issuer: o,
    authorization_endpoint: `${o}${AUTHORIZE_PATH}`,
    token_endpoint: `${o}${TOKEN_PATH}`,
    registration_endpoint: `${o}${REGISTER_PATH}`,
    revocation_endpoint: `${o}${REVOKE_PATH}`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/docs/mcp`,
  };
}

/** `WWW-Authenticate` value for a 401 from /api/mcp. */
export function wwwAuthenticateHeader(origin: string, error?: { code: string; description: string }): string {
  const parts = [
    'Bearer realm="ai-task-manager-mcp"',
    `resource_metadata="${protectedResourceMetadataUrl(origin)}"`,
    `scope="${OAUTH_SCOPES.join(" ")}"`,
  ];
  if (error) {
    parts.push(`error="${error.code}"`, `error_description="${error.description.replace(/["\\]/g, "")}"`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------- secrets

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("hex")}`;
}

export function generateClientId(): string {
  return randomToken(OAUTH_CLIENT_ID_PREFIX, 16);
}
export function generateClientSecret(): string {
  return randomToken(OAUTH_CLIENT_SECRET_PREFIX);
}
export function generateRefreshToken(): string {
  return randomToken(OAUTH_REFRESH_TOKEN_PREFIX);
}
export function generateAuthCode(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------- PKCE

const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  return PKCE_CHALLENGE.test(challenge);
}

export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** RFC 7636 S256 check. Only S256 is supported (OAuth 2.1 / MCP require it). */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!PKCE_VERIFIER.test(verifier)) return false;
  return safeEqual(pkceChallengeFor(verifier), challenge);
}

// ---------------------------------------------------------------------------- scopes

/** The access level a scope string asks for: write if it includes mcp:write, otherwise read. */
export function accessFromScope(scope: string | null | undefined): McpAccess {
  const scopes = (scope ?? "").split(/\s+/).filter(Boolean);
  return scopes.includes(SCOPE_WRITE) ? "write" : "read";
}

export function scopeForAccess(access: McpAccess): string {
  return access === "write" ? `${SCOPE_READ} ${SCOPE_WRITE}` : SCOPE_READ;
}

/** Scopes we don't know about are ignored rather than rejected, as RFC 6749 allows. */
export function unknownScopes(scope: string | null | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter((s) => s && !(OAUTH_SCOPES as readonly string[]).includes(s));
}

// ---------------------------------------------------------------------------- redirect URIs

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Whether a client may register this redirect URI: https anywhere, plain http only on a
 * loopback host (native apps such as Claude Code / Codex listen on 127.0.0.1 or localhost),
 * or a private-use scheme like `cursor://` (RFC 8252 §7.1). Never fragments, and never
 * the schemes a browser would execute.
 */
export function validateRedirectUri(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `redirect_uri "${uri}" is not an absolute URL`;
  }
  if (url.hash) return "redirect_uri must not contain a fragment";
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (["javascript", "data", "vbscript", "file", "blob", "about"].includes(scheme)) {
    return `redirect_uri scheme "${scheme}:" is not allowed`;
  }
  if (scheme === "http" && !isLoopbackHost(url.hostname)) {
    return "http redirect URIs are only allowed on localhost/127.0.0.1 — use https";
  }
  return null;
}

/**
 * Whether `requested` matches one of the registered redirect URIs. Exact string match,
 * except that a loopback http URI may use any port (RFC 8252 §7.3) — native clients pick a
 * free port each time they log in.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !isLoopbackHost(req.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        reg.protocol === "http:" &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

/** Builds the redirect back to the client with `params` added to its query string. */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * RFC 8707: a `resource` the client names must be this MCP endpoint (or the bare origin,
 * which some clients send). Trailing slashes are ignored.
 */
export function resourceMatches(origin: string, resource: string | null | undefined): boolean {
  if (!resource) return true;
  const norm = (s: string) => s.replace(/\/+$/, "");
  return norm(resource) === norm(mcpResourceUrl(origin)) || norm(resource) === norm(trimOrigin(origin));
}

// ---------------------------------------------------------------------------- registration

export interface ClientRegistration {
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  clientUri: string | null;
}

export type RegistrationResult =
  | { ok: true; client: ClientRegistration }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

const MAX_REDIRECT_URIS = 10;

/** Validates an RFC 7591 registration request body. */
export function parseClientRegistration(body: unknown): RegistrationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_client_metadata", description: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris must be a non-empty array of strings" };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: "invalid_redirect_uri", description: `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed` };
  }
  for (const u of uris as string[]) {
    const err = validateRedirectUri(u);
    if (err) return { ok: false, error: "invalid_redirect_uri", description: err };
  }

  const method = b.token_endpoint_auth_method ?? "none";
  if (!AUTH_METHODS.includes(method as TokenEndpointAuthMethod)) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`,
    };
  }

  const grantTypes = b.grant_types;
  if (grantTypes !== undefined) {
    if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code")) {
      return { ok: false, error: "invalid_client_metadata", description: "grant_types must include authorization_code" };
    }
  }
  const responseTypes = b.response_types;
  if (responseTypes !== undefined) {
    if (!Array.isArray(responseTypes) || !responseTypes.includes("code")) {
      return { ok: false, error: "invalid_client_metadata", description: "response_types must include code" };
    }
  }

  const rawName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  const clientUri = typeof b.client_uri === "string" && /^https?:\/\//i.test(b.client_uri) ? b.client_uri : null;

  return {
    ok: true,
    client: {
      name: (rawName || "MCP client").slice(0, 100),
      redirectUris: [...new Set(uris as string[])],
      tokenEndpointAuthMethod: method as TokenEndpointAuthMethod,
      clientUri,
    },
  };
}

// ---------------------------------------------------------------------------- authorize

export interface AuthorizeParams {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  state: string | null;
  scope: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  resource: string | null;
}

export function readAuthorizeParams(get: (name: string) => string | null | undefined): AuthorizeParams {
  const v = (name: string) => {
    const x = get(name);
    return typeof x === "string" && x !== "" ? x : null;
  };
  return {
    responseType: v("response_type"),
    clientId: v("client_id"),
    redirectUri: v("redirect_uri"),
    state: v("state"),
    scope: v("scope"),
    codeChallenge: v("code_challenge"),
    codeChallengeMethod: v("code_challenge_method"),
    resource: v("resource"),
  };
}

export interface KnownClient {
  id: string;
  name: string;
  redirectUris: string[];
}

export type AuthorizeCheck =
  /** Can't trust the redirect URI — show the error to the user, never redirect. */
  | { kind: "fatal"; message: string }
  /** Redirect back to the client with an OAuth error. */
  | { kind: "redirect_error"; redirectUri: string; error: string; description: string }
  | { kind: "ok"; redirectUri: string; requestedAccess: McpAccess };

/**
 * Validates an authorization request (RFC 6749 §4.1.1 + PKCE + RFC 8707). Errors that
 * concern the client or redirect URI are "fatal" (shown, not redirected — an attacker could
 * otherwise bounce users to an arbitrary URL); everything else goes back to the client.
 */
export function checkAuthorizeRequest(
  p: AuthorizeParams,
  client: KnownClient | null,
  origin: string,
): AuthorizeCheck {
  if (!p.clientId) return { kind: "fatal", message: "The request is missing client_id." };
  if (!client) {
    return {
      kind: "fatal",
      message: "Unknown client_id. The app may have been registered against another server — remove and re-add it in your MCP client.",
    };
  }
  let redirectUri: string;
  if (p.redirectUri) {
    if (!redirectUriMatches(client.redirectUris, p.redirectUri)) {
      return { kind: "fatal", message: "redirect_uri doesn't match any URI this client registered." };
    }
    redirectUri = p.redirectUri;
  } else if (client.redirectUris.length === 1) {
    redirectUri = client.redirectUris[0];
  } else {
    return { kind: "fatal", message: "The request is missing redirect_uri." };
  }

  const fail = (error: string, description: string): AuthorizeCheck => ({ kind: "redirect_error", redirectUri, error, description });
  if (p.responseType !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  if (!p.codeChallenge) return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256");
  if ((p.codeChallengeMethod ?? "plain") !== "S256") return fail("invalid_request", "Only code_challenge_method=S256 is supported");
  if (!isValidCodeChallenge(p.codeChallenge)) return fail("invalid_request", "code_challenge is malformed");
  if (!resourceMatches(origin, p.resource)) return fail("invalid_target", "resource must be this server's MCP endpoint");

  return { kind: "ok", redirectUri, requestedAccess: accessFromScope(p.scope) };
}

// ---------------------------------------------------------------------------- token endpoint

export interface ClientCredentials {
  clientId: string | null;
  clientSecret: string | null;
}

/** Client credentials from an `Authorization: Basic` header, falling back to the form body. */
export function readClientCredentials(
  authorization: string | null | undefined,
  body: Record<string, string>,
): ClientCredentials {
  const basic = /^Basic\s+(.+)$/i.exec((authorization ?? "").trim());
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, idx)) || null,
          clientSecret: decodeURIComponent(decoded.slice(idx + 1)) || null,
        };
      }
    } catch {
      // fall through to the body
    }
  }
  return { clientId: body.client_id || null, clientSecret: body.client_secret || null };
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export function tokenResponse(accessToken: string, refreshToken: string, access: McpAccess): TokenResponse {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scopeForAccess(access),
  };
}

/** Parses a token-endpoint body: form-encoded per the spec, JSON tolerated. */
export function parseTokenRequestBody(contentType: string | null, raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if ((contentType ?? "").includes("application/json")) {
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === "object") {
        for (const [k, v] of Object.entries(json)) if (typeof v === "string") out[k] = v;
      }
    } catch {
      // empty body → the caller reports invalid_request
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}
