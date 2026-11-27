// OAuth for the MCP endpoint — the DB half. Pure rules live in src/lib/mcp/oauth.ts.
//
// Grants are McpToken rows: the access token is a regular `tm_mcp_…` token (so
// authenticateMcpRequest() needs no OAuth special-casing beyond the expiry), plus a
// rotating refresh token. Deleting the row in Settings → MCP revokes the grant outright.
import { prisma } from "@/lib/db";
import { generateMcpToken, normalizeMcpAccess, type McpAccess } from "./tokens";
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_CODE_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  generateAuthCode,
  generateClientId,
  generateClientSecret,
  generateRefreshToken,
  safeEqual,
  sha256Hex,
  tokenResponse,
  verifyPkce,
  type ClientCredentials,
  type ClientRegistration,
  type KnownClient,
  type TokenEndpointAuthMethod,
  type TokenResponse,
} from "./oauth";

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
  }
}

export interface StoredClient extends KnownClient {
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  secretHash: string | null;
  clientUri: string | null;
}

function parseUris(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toClient(row: any): StoredClient {
  return {
    id: row.id,
    name: row.name,
    redirectUris: parseUris(row.redirectUris),
    tokenEndpointAuthMethod: (row.tokenEndpointAuthMethod ?? "none") as TokenEndpointAuthMethod,
    secretHash: row.secretHash ?? null,
    clientUri: row.clientUri ?? null,
  };
}

export async function findOAuthClient(clientId: string | null | undefined): Promise<StoredClient | null> {
  if (!clientId) return null;
  const row = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
  return row ? toClient(row) : null;
}

export async function registerOAuthClient(reg: ClientRegistration): Promise<{ client: StoredClient; clientSecret: string | null; createdAt: Date }> {
  const id = generateClientId();
  const clientSecret = reg.tokenEndpointAuthMethod === "none" ? null : generateClientSecret();
  const row = await prisma.oAuthClient.create({
    data: {
      id,
      name: reg.name,
      redirectUris: JSON.stringify(reg.redirectUris),
      tokenEndpointAuthMethod: reg.tokenEndpointAuthMethod,
      secretHash: clientSecret ? sha256Hex(clientSecret) : null,
      clientUri: reg.clientUri,
    },
  });
  return { client: toClient(row), clientSecret, createdAt: row.createdAt };
}

/** Authenticates the client at the token/revocation endpoints. */
export async function authenticateOAuthClient(creds: ClientCredentials): Promise<StoredClient> {
  const client = await findOAuthClient(creds.clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id", 401);
  if (client.secretHash) {
    if (!creds.clientSecret || !safeEqual(sha256Hex(creds.clientSecret), client.secretHash)) {
      throw new OAuthError("invalid_client", "Client authentication failed", 401);
    }
  }
  return client;
}

/** Issues a single-use authorization code after the user approved on the consent page. */
export async function createAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  access: McpAccess;
  resource: string | null;
}): Promise<string> {
  // Opportunistic cleanup — codes live 10 minutes, so this table stays tiny.
  await prisma.oAuthAuthCode.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  const code = generateAuthCode();
  await prisma.oAuthAuthCode.create({
    data: {
      codeHash: sha256Hex(code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      access: input.access,
      resource: input.resource,
      expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_SECONDS * 1000),
    },
  });
  return code;
}

function accessExpiry(): Date {
  return new Date(Date.now() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
}
function refreshExpiry(): Date {
  return new Date(Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000);
}

/** authorization_code grant. */
export async function exchangeAuthorizationCode(
  client: StoredClient,
  params: { code?: string; redirectUri?: string; codeVerifier?: string },
): Promise<TokenResponse> {
  if (!params.code) throw new OAuthError("invalid_request", "code is required");
  if (!params.codeVerifier) throw new OAuthError("invalid_request", "code_verifier is required (PKCE)");

  const row = await prisma.oAuthAuthCode.findUnique({ where: { codeHash: sha256Hex(params.code) } });
  if (!row) throw new OAuthError("invalid_grant", "Authorization code is invalid or was already used");
  // Single use: whoever deletes it first wins, so a replayed code can never mint a second grant.
  const { count } = await prisma.oAuthAuthCode.deleteMany({ where: { id: row.id } });
  if (count === 0) throw new OAuthError("invalid_grant", "Authorization code is invalid or was already used");

  if (row.clientId !== client.id) throw new OAuthError("invalid_grant", "Authorization code was issued to another client");
  if (new Date(row.expiresAt).getTime() < Date.now()) throw new OAuthError("invalid_grant", "Authorization code has expired");
  if (params.redirectUri && params.redirectUri !== row.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (!verifyPkce(params.codeVerifier, row.codeChallenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed");
  }

  const access = normalizeMcpAccess(row.access);
  const { token, keyHash, keyPrefix } = generateMcpToken();
  const refreshToken = generateRefreshToken();
  await prisma.mcpToken.create({
    data: {
      name: `${client.name} (OAuth)`,
      keyHash,
      keyPrefix,
      access,
      expiresAt: accessExpiry(),
      oauthClientId: client.id,
      refreshTokenHash: sha256Hex(refreshToken),
      refreshExpiresAt: refreshExpiry(),
    },
  });
  prisma.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return tokenResponse(token, refreshToken, access);
}

/**
 * refresh_token grant. Rotates both tokens on the same McpToken row, so the grant keeps
 * its name, access level (including any change made in Settings → MCP) and history.
 */
export async function refreshGrant(client: StoredClient, refreshToken: string | undefined): Promise<TokenResponse> {
  if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
  const oldHash = sha256Hex(refreshToken);
  const row = await prisma.mcpToken.findUnique({ where: { refreshTokenHash: oldHash } });
  if (!row || row.oauthClientId !== client.id) throw new OAuthError("invalid_grant", "Refresh token is invalid or was revoked");
  if (row.refreshExpiresAt && new Date(row.refreshExpiresAt).getTime() < Date.now()) {
    throw new OAuthError("invalid_grant", "Refresh token has expired — sign in again");
  }

  const access = normalizeMcpAccess(row.access);
  const { token, keyHash, keyPrefix } = generateMcpToken();
  const nextRefresh = generateRefreshToken();
  // Conditional on the old hash so two concurrent refreshes can't both succeed.
  const { count } = await prisma.mcpToken.updateMany({
    where: { id: row.id, refreshTokenHash: oldHash },
    data: {
      keyHash,
      keyPrefix,
      expiresAt: accessExpiry(),
      refreshTokenHash: sha256Hex(nextRefresh),
      refreshExpiresAt: refreshExpiry(),
    },
  });
  if (count === 0) throw new OAuthError("invalid_grant", "Refresh token is invalid or was revoked");
  prisma.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return tokenResponse(token, nextRefresh, access);
}

/** RFC 7009: revoking either token of a grant ends the whole grant. Unknown tokens are not an error. */
export async function revokeOAuthToken(client: StoredClient, token: string | undefined): Promise<void> {
  if (!token) throw new OAuthError("invalid_request", "token is required");
  const hash = sha256Hex(token);
  await prisma.mcpToken.deleteMany({
    where: { oauthClientId: client.id, OR: [{ keyHash: hash }, { refreshTokenHash: hash }] },
  });
}
