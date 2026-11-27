/**
 * Runtime half of "Sign in with Claude" (see `claude-login.ts` for the flow and pure helpers).
 *
 * A login is two HTTP requests — start (get the URL) and submit (paste the code) — with the
 * `claude auth login` process waiting on stdin in between, so the live process is kept in an
 * in-memory session map on `globalThis` (survives dev-mode module reloads). That ties a
 * session to one app process, which is fine for the single-replica deployment; a session that
 * is never finished is killed after SESSION_TTL_MS.
 *
 * Each login runs with CLAUDE_CONFIG_DIR pointed at a fresh private temp dir, so it can't
 * touch any provider's real config dir or the login of a task that's running; the resulting
 * `.credentials.json` is read out of it, saved onto the provider, and the dir is deleted.
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  cleanCliOutput,
  extractLoginUrl,
  loginErrorMessage,
  looksLikeLoginSuccess,
  normalizeLoginCode,
  parseLoginCredentials,
} from "./claude-login";

const SESSION_TTL_MS = 10 * 60 * 1000;
const URL_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;
/** After a code is sent, this much silence with no credentials (and no success text) = rejected. */
const REJECT_QUIET_MS = 2_000;

interface LoginSession {
  id: string;
  providerId: string;
  child: ChildProcess;
  dir: string;
  output: string;
  exited: boolean;
  lastOutputAt: number;
  timer: NodeJS.Timeout;
  submitting: boolean;
}

const globalForLogin = globalThis as unknown as { __claudeLoginSessions?: Map<string, LoginSession> };
const sessions = (globalForLogin.__claudeLoginSessions ??= new Map<string, LoginSession>());

function endSession(session: LoginSession): void {
  clearTimeout(session.timer);
  sessions.delete(session.id);
  if (!session.exited) {
    try { session.child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  try { rmSync(session.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Cancel a login in progress (no-op when it's already gone). */
export function cancelClaudeLogin(sessionId: string, providerId: string): void {
  const session = sessions.get(sessionId);
  if (session && session.providerId === providerId) endSession(session);
}

/**
 * Start `claude auth login --claudeai` for a provider and return the sign-in URL it prints.
 * Starting again for the same provider abandons the previous attempt.
 */
export async function startClaudeLogin(providerId: string): Promise<{ sessionId: string; url: string }> {
  for (const s of sessions.values()) if (s.providerId === providerId) endSession(s);

  const dir = mkdtempSync(join(tmpdir(), "ctm-claude-login-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [process.env.PATH ?? "", process.env.CLAUDE_PATH].filter(Boolean).join(":"),
    CLAUDE_CONFIG_DIR: dir,
    // The sign-in page is opened by the user's browser, never one on the server.
    BROWSER: "true",
    NO_COLOR: "1",
  };
  // An inherited token would make the CLI consider itself signed in already.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;

  let child: ChildProcess;
  try {
    child = spawn("claude", ["auth", "login", "--claudeai"], { env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Couldn't start the Claude CLI: ${String(err)}`);
  }

  const session: LoginSession = {
    id: randomUUID(),
    providerId,
    child,
    dir,
    output: "",
    exited: false,
    lastOutputAt: Date.now(),
    timer: setTimeout(() => endSession(session), SESSION_TTL_MS),
    submitting: false,
  };
  sessions.set(session.id, session);

  const onData = (chunk: Buffer) => {
    session.output += chunk.toString("utf8");
    if (session.output.length > 64_000) session.output = session.output.slice(-64_000);
    session.lastOutputAt = Date.now();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.stdin?.on("error", () => { /* process gone; handled via exit */ });

  const spawnError = new Promise<string>((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      session.exited = true;
      resolve(err.code === "ENOENT" ? "The Claude CLI (`claude`) isn't installed on the server." : String(err));
    });
    child.on("exit", () => {
      session.exited = true;
      resolve(loginErrorMessage(session.output, "The Claude CLI exited before showing a sign-in link."));
    });
  });

  const deadline = Date.now() + URL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = extractLoginUrl(session.output);
    if (url) return { sessionId: session.id, url };
    if (session.exited) {
      const message = await spawnError;
      endSession(session);
      throw new Error(message);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  endSession(session);
  throw new Error("Timed out waiting for the Claude CLI to show a sign-in link.");
}

export type SubmitLoginResult =
  | { ok: true; credentialsJson: string }
  /** `retry`: the session is still alive and another code can be submitted. */
  | { ok: false; error: string; retry: boolean };

/**
 * Pass the pasted code to the waiting CLI. On success returns the new `.credentials.json`
 * (the session is then closed); the caller saves it onto the provider.
 */
export async function submitClaudeLoginCode(sessionId: string, providerId: string, input: string): Promise<SubmitLoginResult> {
  const session = sessions.get(sessionId);
  if (!session || session.providerId !== providerId) {
    return { ok: false, error: "This sign-in attempt has expired. Start again.", retry: false };
  }
  const normalized = normalizeLoginCode(input);
  if (!normalized.ok) return { ok: false, error: normalized.error, retry: true };
  if (session.submitting) return { ok: false, error: "A code is already being checked.", retry: true };
  if (session.exited) {
    endSession(session);
    return { ok: false, error: "The sign-in attempt ended. Start again.", retry: false };
  }

  session.submitting = true;
  const outputBefore = session.output.length;
  const credentialsFile = join(session.dir, ".credentials.json");
  try {
    session.child.stdin?.write(`${normalized.code}\n`);
    const sentAt = Date.now();

    while (Date.now() - sentAt < SUBMIT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 300));

      const credentials = existsSync(credentialsFile) ? parseLoginCredentials(safeRead(credentialsFile)) : null;
      if (credentials) {
        endSession(session);
        return { ok: true, credentialsJson: credentials };
      }

      const since = session.output.slice(outputBefore);
      if (session.exited) {
        endSession(session);
        return {
          ok: false,
          error: `${loginErrorMessage(since, "Sign-in failed.")}${process.platform === "darwin" && looksLikeLoginSuccess(since) ? " (On macOS the CLI keeps its login in the Keychain, so it can't be read from here.)" : ""}`,
          retry: false,
        };
      }
      // The CLI answered and went quiet without writing credentials: it rejected the code and is
      // waiting for another one.
      if (cleanCliOutput(since).trim() && !looksLikeLoginSuccess(since) && Date.now() - session.lastOutputAt > REJECT_QUIET_MS) {
        return { ok: false, error: loginErrorMessage(since), retry: true };
      }
    }
    endSession(session);
    return { ok: false, error: "Timed out waiting for the Claude CLI to finish signing in.", retry: false };
  } finally {
    session.submitting = false;
  }
}

function safeRead(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
