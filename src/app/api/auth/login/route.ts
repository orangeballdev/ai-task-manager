import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { completeSignIn, jsonError, readJson } from "@/lib/auth/http";
import { recordAuthEvent } from "@/lib/auth/audit";
import { dummyPasswordHash, verifyPassword } from "@/lib/auth/password";
import { normalizeEmail, passwordLoginAllowed } from "@/lib/auth/policy";
import { LOGIN_RULES, loginLimiter } from "@/lib/auth/rate-limit";
import { clientIp } from "@/lib/auth/request-info";

// Email + password sign-in.
export const dynamic = "force-dynamic";

const INVALID = "Invalid email or password.";

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return jsonError(400, "Email and password are required.");

  const ip = clientIp(req.headers) ?? "unknown";
  const ipKey = `ip:${ip}`;
  const accountKey = `acct:${ip}:${email}`;
  const emailKey = `email:${email}`;
  const wait = Math.max(
    loginLimiter.retryAfterMs(ipKey, LOGIN_RULES.ip),
    loginLimiter.retryAfterMs(accountKey, LOGIN_RULES.account),
    loginLimiter.retryAfterMs(emailKey, LOGIN_RULES.email),
  );
  if (wait > 0) {
    await recordAuthEvent(req.headers, { method: "password", success: false, email, reason: "rate_limited" });
    const minutes = Math.ceil(wait / 60000);
    return jsonError(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: { _count: { select: { passkeys: true } } },
  });

  const fail = async (reason: string, userId?: string) => {
    loginLimiter.recordFailure(ipKey, LOGIN_RULES.ip);
    loginLimiter.recordFailure(accountKey, LOGIN_RULES.account);
    loginLimiter.recordFailure(emailKey, LOGIN_RULES.email);
    await recordAuthEvent(req.headers, { method: "password", success: false, email, userId, reason });
  };

  if (!user) {
    await verifyPassword(password, await dummyPasswordHash()); // keep timing uniform
    await fail("unknown_email");
    return jsonError(401, INVALID);
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await fail(user.passwordHash ? "bad_password" : "no_password", user.id);
    return jsonError(401, INVALID);
  }
  const state = {
    passwordHash: user.passwordHash,
    passwordLoginDisabled: user.passwordLoginDisabled,
    passkeyCount: user._count.passkeys,
  };
  if (!passwordLoginAllowed(state)) {
    // The password was right, so saying why is safe — and needed, or the user can't tell.
    await recordAuthEvent(req.headers, {
      method: "password",
      success: false,
      email,
      userId: user.id,
      reason: "password_login_disabled",
    });
    return jsonError(403, "Password sign-in is turned off for this account. Sign in with your passkey.", {
      code: "password_login_disabled",
    });
  }

  loginLimiter.clear(accountKey);
  return completeSignIn(req, user, "password");
}
