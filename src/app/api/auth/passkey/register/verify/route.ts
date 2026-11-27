import { NextRequest, NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { requireSession } from "@/lib/auth/session";
import { jsonError, readJson } from "@/lib/auth/http";
import { clearChallengeCookie, verifyRegistration } from "@/lib/auth/webauthn";

// Step 2 of adding a passkey: verify the browser's attestation and store the credential.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body.response || typeof body.response !== "object") return jsonError(400, "response is required");
  const name = typeof body.name === "string" ? body.name : "";
  const result = await verifyRegistration(req, auth.session.user.id, body.response as RegistrationResponseJSON, name);
  const res = result.ok ? NextResponse.json({ ok: true, id: result.passkeyId }) : jsonError(400, result.error);
  clearChallengeCookie(res);
  return res;
}
