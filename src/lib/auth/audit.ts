// Sign-in audit trail (SignInEvent rows), shown in Settings → Security.
import { prisma } from "@/lib/db";
import { clientIp, clientUserAgent } from "./request-info";

export type AuthEventMethod = "password" | "passkey" | "signup" | "logout" | "password_change";

export interface AuthEventInput {
  method: AuthEventMethod;
  success: boolean;
  userId?: string | null;
  email?: string | null;
  reason?: string | null;
}

/** Records one event. Never throws — auditing must not break sign-in. */
export async function recordAuthEvent(headers: { get(name: string): string | null }, e: AuthEventInput): Promise<void> {
  try {
    await prisma.signInEvent.create({
      data: {
        method: e.method,
        success: e.success,
        userId: e.userId ?? null,
        email: e.email ? e.email.slice(0, 254) : null,
        reason: e.reason ?? null,
        ip: clientIp(headers),
        userAgent: clientUserAgent(headers),
      },
    });
  } catch (err) {
    console.error("[auth] failed to record sign-in event:", err);
  }
  const outcome = e.success ? "ok" : `failed (${e.reason ?? "unknown"})`;
  console.log(`[auth] ${e.method} ${outcome} email=${e.email ?? "-"} ip=${clientIp(headers) ?? "-"}`);
}
