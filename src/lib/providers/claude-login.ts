/**
 * Pure helpers for the in-app "Sign in with Claude" flow (Settings → AI).
 *
 * The flow drives the real CLI rather than re-implementing its OAuth client:
 * `claude auth login --claudeai` runs without a TTY, prints a sign-in URL and then reads the
 * code from stdin ("Paste code here if prompted >"). The browser that opens the URL is the
 * user's, not the server's, so this works for a task manager running on a remote host too —
 * after signing in, claude.ai shows a `code#state` string that the user pastes back.
 *
 * The runtime half (spawning, sessions, saving) is `claude-login-runtime.ts`.
 */

/** Strip ANSI escapes and carriage returns so CLI output can be matched and shown. */
export function cleanCliOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
}

/** The sign-in URL the CLI prints, or null when it hasn't printed one (yet). */
export function extractLoginUrl(output: string): string | null {
  const match = cleanCliOutput(output).match(/https:\/\/\S+\/oauth\/authorize\?\S+/);
  return match ? match[0] : null;
}

export type NormalizedLoginCode = { ok: true; code: string } | { ok: false; error: string };

/**
 * Turn what the user pasted into the `code#state` string the CLI expects. Accepts the code as
 * shown on the callback page, or the callback page's whole URL (`…?code=X&state=Y`).
 * Rejecting an obviously partial code here keeps the CLI session alive for another try.
 */
export function normalizeLoginCode(input: string): NormalizedLoginCode {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Paste the code shown after you sign in." };

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (code && state) return { ok: true, code: `${code}#${state}` };
    } catch {
      /* fall through to the generic message */
    }
    return { ok: false, error: "That URL doesn't contain a sign-in code. Paste the code shown on the page instead." };
  }

  const code = raw.replace(/\s+/g, "");
  const [left, right, ...rest] = code.split("#");
  if (!left || !right || rest.length > 0) {
    return { ok: false, error: "That doesn't look like the full code. Copy all of it, including the # in the middle." };
  }
  return { ok: true, code };
}

/**
 * Validate the `.credentials.json` the CLI wrote after a successful sign-in. Returns the
 * trimmed JSON to store, or null when it isn't a usable subscription login.
 */
export function parseLoginCredentials(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown } };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
    if (typeof oauth.refreshToken !== "string" || !oauth.refreshToken) return null;
    return text;
  } catch {
    return null;
  }
}

/** Whether CLI output printed after the code was submitted reads as a successful sign-in. */
export function looksLikeLoginSuccess(output: string): boolean {
  return /login successful|logged in|signed in/i.test(cleanCliOutput(output));
}

/**
 * The message to show for output the CLI printed after rejecting a code: its last meaningful
 * lines, without the prompt it re-printed.
 */
export function loginErrorMessage(output: string, fallback = "Sign-in failed."): string {
  const lines = cleanCliOutput(output)
    .split("\n")
    .map((l) => l.replace(/Paste code here if prompted\s*>\s*/gi, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return fallback;
  return lines.slice(-3).join(" ").slice(0, 500);
}
