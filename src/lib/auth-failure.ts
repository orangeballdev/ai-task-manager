/**
 * Detecting a run that died because the provider's login is dead, not because of the task.
 *
 * "Failed to authenticate: OAuth session expired and could not be refreshed" is not something
 * a retry on the same connection can fix — the credentials have to be re-pasted — but nothing
 * about the task itself is wrong. The worker therefore treats it like a rate limit: hand the
 * task (and the work already in its workspace) to another enabled provider and carry on,
 * instead of failing it. See the `authFailed` branch in `src/worker/index.ts`.
 *
 * The patterns are deliberately narrow and only ever run over *diagnostic* output (stderr,
 * error events, the last few lines a failed run printed): an agent that writes "added 401
 * handling" or "fix: token expired bug" into its transcript must not take a connection out of
 * rotation. A bare "401" or "unauthorized" is therefore not enough on its own.
 */

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /failed to authenticate/i,
  /oauth (?:session|token)[^\n]*(?:expired|revoked|invalid|could not be refreshed)/i,
  /(?:session|token|credentials?|login)[^\n]{0,40}could not be refreshed/i,
  /\bauthentication_error\b/i,
  /\binvalid[ _-]x-api-key\b/i,
  /\binvalid api key\b/i,
  /\bapi key (?:is )?invalid\b/i,
  /please run \/login/i,
  /\binvalid_grant\b/i,
  /\b401\b[^\n]{0,80}(?:unauthori[sz]ed|authenticat|credential|api key|token)/i,
  /(?:unauthori[sz]ed|authenticat)[^\n]{0,80}\b401\b/i,
  /credentials? (?:have |has )?expired/i,
];

/** How many trailing lines of a failed run's regular output are worth scanning. */
export const AUTH_FAILURE_TAIL_LINES = 8;

/**
 * The first line in `text` that says the provider could not authenticate, or null.
 * Only pass diagnostic output here — see the module comment.
 */
export function detectProviderAuthFailure(text: string): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (AUTH_FAILURE_PATTERNS.some((p) => p.test(trimmed))) return trimmed.slice(0, 300);
  }
  return null;
}

/** The last `n` non-empty lines of a run's output, joined back together. */
export function tailLines(chunks: string[], n: number = AUTH_FAILURE_TAIL_LINES): string {
  const lines = chunks.join("\n").split("\n").filter((l) => l.trim());
  return lines.slice(-n).join("\n");
}

