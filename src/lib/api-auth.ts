// Shared Bearer-token authentication for the public API (src/app/api/v1/*).
//
// Every /api/v1/* route calls authenticateApiRequest() first and returns its error
// response as-is when auth fails. On success it hands back the ApiKey row so routes
// can (optionally) log which key made the call. lastUsedAt is updated best-effort and
// never blocks the request.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashApiKey } from "@/lib/api-keys";

export interface AuthedApiKey {
  id: string;
  name: string;
  /** The key's LLM gateway provider choice (see ApiKeyProviderChoice). */
  aiProviderId: string | null;
  useSmartProvider: boolean;
}

export type ApiAuthResult =
  | { ok: true; apiKey: AuthedApiKey }
  | { ok: false; response: NextResponse };

/** Stripe-style error envelope used across every /api/v1/* response. */
export function apiError(status: number, message: string, code?: string): NextResponse {
  return NextResponse.json({ error: { message, ...(code && { code }) } }, { status });
}

/**
 * Looks up the ApiKey row for a plaintext key and bumps its lastUsedAt (best-effort).
 * Shared by the v1 API and the LLM gateway, which reads the key from different headers.
 */
export async function findApiKey(token: string): Promise<AuthedApiKey | null> {
  if (!token.trim()) return null;
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(token) } });
  if (!apiKey) return null;
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return {
    id: apiKey.id,
    name: apiKey.name,
    aiProviderId: apiKey.aiProviderId,
    useSmartProvider: apiKey.useSmartProvider,
  };
}

export async function authenticateApiRequest(req: NextRequest): Promise<ApiAuthResult> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();

  if (!token) {
    return {
      ok: false,
      response: apiError(
        401,
        "No API key provided. Include one as 'Authorization: Bearer tm_live_...'. Create a key under Settings -> API.",
        "missing_api_key"
      ),
    };
  }

  const apiKey = await findApiKey(token);
  if (!apiKey) {
    return { ok: false, response: apiError(401, "Invalid API key.", "invalid_api_key") };
  }

  return { ok: true, apiKey };
}
