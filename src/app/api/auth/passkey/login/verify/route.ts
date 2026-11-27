import { NextRequest } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { completeSignIn, jsonError, readJson } from "@/lib/auth/http";
import { recordAuthEvent } from "@/lib/auth/audit";
import { LOGIN_RULES, loginLimiter } from "@/lib/auth/rate-limit";
import { clientIp } from "@/lib/auth/request-info";
import { clearChallengeCookie, verifyAuthentication } from "@/lib/auth/webauthn";

// Public: step 2 of signing in with a passkey — verify the assertion and start a session.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const ipKey = `ip:${clientIp(req.headers) ?? "unknown"}`;
  if (loginLimiter.retryAfterMs(ipKey, LOGIN_RULES.ip) > 0) {
    await recordAuthEvent(req.headers, { method: "passkey", success: false, reason: "rate_limited" });
    return jsonError(429, "Too many failed attempts. Try again later.");
  }
  const body = await readJson(req);
  const result = await verifyAuthentication(req, body.response as AuthenticationResponseJSON);
  if (!result.ok) {
    loginLimiter.recordFailure(ipKey, LOGIN_RULES.ip);
    await recordAuthEvent(req.headers, {
      method: "passkey",
      success: false,
      reason: result.reason,
      userId: result.userId,
      email: result.email,
    });
    const res = jsonError(401, result.error);
    clearChallengeCookie(res);
    return res;
  }
  const res = await completeSignIn(req, { id: result.userId, email: result.email }, "passkey");
  clearChallengeCookie(res);
  return res;
}
