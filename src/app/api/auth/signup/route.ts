import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { completeSignIn, jsonError, readJson, signupsEnabled } from "@/lib/auth/http";
import { recordAuthEvent } from "@/lib/auth/audit";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { isValidEmail, normalizeEmail } from "@/lib/auth/policy";

// Creates an account and signs it in. Refused unless sign-ups are enabled in
// Settings → Security (they're off by default).
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);

  if (!(await signupsEnabled())) {
    await recordAuthEvent(req.headers, { method: "signup", success: false, email, reason: "signups_disabled" });
    return jsonError(403, "Sign-ups are disabled.");
  }
  if (!isValidEmail(email)) return jsonError(400, "Enter a valid email address.");
  const pwError = validatePasswordStrength(body.password);
  if (pwError) return jsonError(400, pwError);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) || null : null;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await recordAuthEvent(req.headers, { method: "signup", success: false, email, reason: "email_taken" });
    return jsonError(409, "An account with this email already exists.");
  }

  const user = await prisma.user.create({
    data: { email, name, passwordHash: await hashPassword(body.password as string) },
  });
  return completeSignIn(req, user, "signup");
}
