// Pure authentication rules (no DB, no Next.js imports) — unit-tested in
// src/lib/__tests__/auth-policy.test.ts. The proxy (src/proxy.ts) and the
// /api/auth/* routes all decide through these functions.

export const SESSION_COOKIE = "tm_session";
export const CHALLENGE_COOKIE = "tm_webauthn";
/** Sessions last 30 days from sign-in. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** WebAuthn ceremonies must finish within 5 minutes. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Setting row that controls whether /signup creates accounts ("true"/"false"). */
export const SIGNUPS_SETTING_KEY = "auth_signups_enabled";
/**
 * Setting row that controls whether the web UI requires signing in ("true"/"false").
 * Missing = off, so a fresh install opens straight into the app; the migration that
 * introduced it turns it on for installs that were already using sign-in.
 */
export const AUTH_REQUIRED_SETTING_KEY = "auth_required";

/**
 * Paths reachable without a browser session. Each of these either has nothing to
 * protect (sign-in pages, static assets) or enforces its own credential:
 * API keys (/api/v1, /api/llm), MCP tokens (/api/mcp), OAuth client auth
 * (/api/oauth/register|token|revoke, /.well-known), webhook secrets
 * (/api/webhooks/receive) and the SNS topic check (/api/integrations/email/inbound).
 *
 * The MCP OAuth *consent* page (/oauth/authorize) and its form target
 * (/api/oauth/authorize) are deliberately NOT here: approving a client now
 * requires being signed in.
 */
const PUBLIC_EXACT = new Set<string>([
  "/login",
  "/signup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/signup",
  "/api/auth/config",
  "/api/auth/passkey/login/options",
  "/api/auth/passkey/login/verify",
  "/api/mcp",
  "/api/oauth/register",
  "/api/oauth/token",
  "/api/oauth/revoke",
  "/api/integrations/email/inbound",
  "/favicon.ico",
  "/icon.svg",
  "/apple-icon.png",
  "/manifest.webmanifest",
  "/robots.txt",
]);

const PUBLIC_PREFIXES = [
  "/_next/static/",
  "/_next/image",
  "/api/v1/",
  "/api/llm/",
  "/api/mcp/",
  "/.well-known/",
  "/api/webhooks/receive/",
  "/icons/",
];

const STATIC_ASSET = /\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|webmanifest)$/i;

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  // Files served from /public (icons, svgs). Never applies under /api.
  if (!pathname.startsWith("/api/") && STATIC_ASSET.test(pathname)) return true;
  return false;
}

/** API requests get a 401; everything else is redirected to the sign-in page. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Sign-ups default to off: an internet-facing install shouldn't hand out accounts. */
export function parseSignupsEnabled(value: string | null | undefined): boolean {
  return value === "true";
}

/** Sign-in for the web UI defaults to off: only an explicit "true" turns it on. */
export function parseAuthRequired(value: string | null | undefined): boolean {
  return value === "true";
}

/**
 * Returns an error message, or null when the "require sign-in" switch may be flipped.
 * Turning it on needs a signed-in session, which proves the person flipping it has an
 * account that actually works — otherwise they could lock themselves out. Turning it
 * off only happens while it's on, so the proxy has already demanded a session.
 */
export function checkAuthRequiredToggle(enable: boolean, signedIn: boolean): string | null {
  if (!signedIn) {
    return enable
      ? "Sign in before turning on required sign-in, so you know your account works."
      : "Not signed in";
  }
  return null;
}

/**
 * Only same-site relative paths are honoured as a post-login redirect, so
 * /login?next=https://evil.example can't bounce a user off-site.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/login") || next.startsWith("/signup") || next.startsWith("/api/")) return "/";
  return next;
}

export interface PasswordLoginState {
  passwordHash: string | null;
  passwordLoginDisabled: boolean;
  passkeyCount: number;
}

/**
 * Password sign-in is allowed when the account has a password and hasn't switched it
 * off. A "disabled" flag with no passkeys left is ignored, so an account can never be
 * left with no way in.
 */
export function passwordLoginAllowed(u: PasswordLoginState): boolean {
  if (!u.passwordHash) return false;
  if (u.passwordLoginDisabled && u.passkeyCount > 0) return false;
  return true;
}

/** Returns an error message, or null when the change is allowed. */
export function checkPasswordLoginToggle(u: PasswordLoginState, disable: boolean): string | null {
  if (disable && u.passkeyCount === 0) {
    return "Add a passkey before disabling password sign-in.";
  }
  if (!disable && !u.passwordHash) {
    return "Set a password before enabling password sign-in.";
  }
  return null;
}

/** Returns an error message, or null when the passkey may be removed. */
export function checkPasskeyRemoval(u: PasswordLoginState): string | null {
  if (u.passkeyCount <= 1 && !u.passwordHash) {
    return "This is your only way to sign in. Set a password before removing it.";
  }
  return null;
}

/** Whether deleting a passkey must also re-enable password sign-in (last passkey gone). */
export function reenablePasswordAfterRemoval(u: PasswordLoginState): boolean {
  return u.passwordLoginDisabled && u.passkeyCount <= 1;
}

/**
 * Whether the session cookie should carry the Secure flag: only when the browser is
 * talking HTTPS (directly or via a TLS-terminating proxy's X-Forwarded-Proto). Plain-HTTP
 * LAN access keeps working; browsers drop Secure cookies on http:// origins.
 */
export function isSecureRequest(forwardedProto: string | null | undefined, urlProtocol: string): boolean {
  const proto = forwardedProto?.split(",")[0].trim() || urlProtocol.replace(/:$/, "");
  return proto === "https";
}
