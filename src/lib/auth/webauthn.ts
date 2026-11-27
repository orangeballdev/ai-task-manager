// Passkey (WebAuthn) ceremonies on top of @simplewebauthn/server.
//
// The relying party is the host the browser is on (requestOrigin()), so a passkey
// registered at https://tasks.example.com works there only — not on the LAN IP.
// WebAuthn also needs a secure context: HTTPS, or http://localhost.
//
// Each ceremony is two calls: *options* stores a random challenge in AuthChallenge
// and points an httpOnly cookie at it; *verify* consumes that row (single use,
// 5-minute expiry) and checks the browser's signed response against it.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requestOrigin } from "@/lib/request-origin";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_MS, isSecureRequest } from "./policy";

const RP_NAME = "AI Task Manager";

export function relyingParty(req: NextRequest): { rpID: string; origins: string[] } {
  const origin = requestOrigin(req);
  const url = new URL(origin);
  // Behind a proxy that doesn't forward the scheme our idea of the protocol can be
  // wrong; the RP ID (hostname) is what actually binds the credential.
  const other = `${url.protocol === "https:" ? "http:" : "https:"}//${url.host}`;
  return { rpID: url.hostname, origins: [origin, other] };
}

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as AuthenticatorTransportFuture[]) : undefined;
  } catch {
    return undefined;
  }
}

async function storeChallenge(
  res: NextResponse,
  req: NextRequest,
  challenge: string,
  type: "register" | "authenticate",
  userId: string | null,
): Promise<void> {
  const row = await prisma.authChallenge.create({
    data: { challenge, type, userId, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  });
  res.cookies.set(CHALLENGE_COOKIE, row.id, {
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureRequest(req.headers.get("x-forwarded-proto"), req.nextUrl.protocol),
    path: "/api/auth",
    maxAge: Math.floor(CHALLENGE_TTL_MS / 1000),
  });
}

/** Consumes (deletes) the challenge the cookie points at. Returns it when still valid. */
async function takeChallenge(
  req: NextRequest,
  type: "register" | "authenticate",
): Promise<{ challenge: string; userId: string | null } | null> {
  const id = req.cookies.get(CHALLENGE_COOKIE)?.value;
  if (!id) return null;
  const row = await prisma.authChallenge.findUnique({ where: { id } });
  if (!row) return null;
  await prisma.authChallenge.delete({ where: { id } }).catch(() => {});
  if (row.type !== type || new Date(row.expiresAt).getTime() < Date.now()) return null;
  return { challenge: row.challenge, userId: row.userId };
}

export function clearChallengeCookie(res: NextResponse): void {
  res.cookies.set(CHALLENGE_COOKIE, "", { path: "/api/auth", maxAge: 0 });
}

// ---- Registration (signed-in user adds a passkey) ----

export async function registrationOptionsResponse(
  req: NextRequest,
  user: { id: string; email: string; name: string | null },
): Promise<NextResponse> {
  const { rpID } = relyingParty(req);
  const existing = await prisma.passkey.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((p: { credentialId: string; transports: string | null }) => ({
      id: p.credentialId,
      transports: parseTransports(p.transports),
    })),
    // Discoverable credentials are what makes "Sign in with a passkey" work without
    // typing an email first.
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  const res = NextResponse.json(options);
  await storeChallenge(res, req, options.challenge, "register", user.id);
  return res;
}

export type PasskeyVerifyResult = { ok: true; passkeyId: string } | { ok: false; error: string };

export async function verifyRegistration(
  req: NextRequest,
  userId: string,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeyVerifyResult> {
  const stored = await takeChallenge(req, "register");
  if (!stored || stored.userId !== userId) return { ok: false, error: "Passkey setup expired. Please try again." };
  const { rpID, origins } = relyingParty(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Passkey verification failed." };
  }
  if (!verification.verified) return { ok: false, error: "Passkey verification failed." };
  const info = verification.registrationInfo;
  const already = await prisma.passkey.findUnique({ where: { credentialId: info.credential.id } });
  if (already) return { ok: false, error: "This passkey is already registered." };
  const row = await prisma.passkey.create({
    data: {
      userId,
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: JSON.stringify(info.credential.transports ?? response.response.transports ?? []),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      name: name.trim().slice(0, 100) || "Passkey",
    },
  });
  return { ok: true, passkeyId: row.id };
}

// ---- Authentication (sign in with a passkey) ----

export async function authenticationOptionsResponse(req: NextRequest): Promise<NextResponse> {
  const { rpID } = relyingParty(req);
  // No allowCredentials: the browser offers whichever discoverable passkeys it holds
  // for this site, so the server never reveals which emails have accounts.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  const res = NextResponse.json(options);
  await storeChallenge(res, req, options.challenge, "authenticate", null);
  return res;
}

export type PasskeyLoginResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string; reason: string; userId?: string; email?: string };

export async function verifyAuthentication(
  req: NextRequest,
  response: AuthenticationResponseJSON,
): Promise<PasskeyLoginResult> {
  const stored = await takeChallenge(req, "authenticate");
  if (!stored) return { ok: false, error: "Sign-in expired. Please try again.", reason: "challenge_expired" };
  if (!response?.id) return { ok: false, error: "Invalid passkey response.", reason: "bad_request" };
  const passkey = await prisma.passkey.findUnique({
    where: { credentialId: response.id },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!passkey) return { ok: false, error: "This passkey isn't registered here.", reason: "unknown_passkey" };
  const { rpID, origins } = relyingParty(req);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports),
      },
      requireUserVerification: false,
    });
  } catch (err) {
    return {
      ok: false,
      error: "Passkey verification failed.",
      reason: `verify_error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      userId: passkey.user.id,
      email: passkey.user.email,
    };
  }
  if (!verification.verified) {
    return { ok: false, error: "Passkey verification failed.", reason: "not_verified", userId: passkey.user.id, email: passkey.user.email };
  }
  await prisma.passkey.update({
    where: { id: passkey.id },
    data: {
      counter: verification.authenticationInfo.newCounter,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date(),
    },
  });
  return { ok: true, userId: passkey.user.id, email: passkey.user.email };
}
