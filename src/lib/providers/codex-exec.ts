/**
 * Shared plumbing for the Codex CLI (`codex`).
 *
 * Everything that shells out to Codex — the task provider, the health check's liveness
 * probe, the assistant/Slack helper routes — goes through here so they can't disagree
 * about how the binary is found, how its auth file is written, or how its JSONL event
 * stream is interpreted.
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { reportLlmUsage } from "../llm-usage-context";

/** Codex's default per-user home, mirroring `~/.claude` for the Claude CLI. */
export function resolveCodexHome(configDir?: string | null): string {
  return configDir?.trim() || join(homedir(), ".codex");
}

/** Where Codex keeps the credentials written by `codex login`. */
export function codexAuthFile(configDir?: string | null): string {
  return join(resolveCodexHome(configDir), "auth.json");
}

/**
 * Directories a Codex install commonly lands in. `codex` is distributed as an npm global
 * and as a standalone binary, and neither is guaranteed to be on the PATH of a long-running
 * service started by systemd/Docker — so probe the usual places rather than failing with
 * "not found" when the binary is sitting right there.
 */
function candidateBinDirs(): string[] {
  const home = homedir();
  return [
    process.env.CODEX_PATH,
    join(home, ".codex", "bin"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
  ].filter((d): d is string => !!d);
}

/** PATH with every plausible Codex install directory appended. */
export function codexPath(): string {
  const seen = new Set<string>();
  const parts = [...(process.env.PATH ?? "").split(":"), ...candidateBinDirs()];
  return parts.filter((p) => p && !seen.has(p) && (seen.add(p), true)).join(":");
}

/** Absolute path to the `codex` binary if we can find one, else null. */
export function findCodexBinary(): string | null {
  for (const dir of codexPath().split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "codex");
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* unreadable dir — keep looking */
    }
  }
  return null;
}

export const CODEX_NOT_FOUND_MESSAGE =
  "Codex CLI not found. Install it with `npm install -g @openai/codex` (or set CODEX_PATH to the directory containing the `codex` binary).";

/** Environment for a Codex child process: augmented PATH + the provider's isolated CODEX_HOME. */
export function codexEnv(configDir?: string | null): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: codexPath(),
    CODEX_HOME: resolveCodexHome(configDir),
  };
}

/**
 * Write a provider's stored `auth.json` to its Codex home so the CLI can authenticate.
 * Unlike the Claude CLI's credentials there is no expiry field we can compare, so a
 * newer on-disk copy is preserved by `syncCodexAuthToDb()` after each run instead.
 */
export function writeCodexAuth(configDir: string | null | undefined, credentialsJson: string): void {
  const dir = resolveCodexHome(configDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), credentialsJson, { encoding: "utf8", mode: 0o600 });
}

/** The provider's stored auth, falling back to whatever `codex login` left on disk. */
export function readCodexAuth(provider: { credentialsJson?: string | null; configDir?: string | null }): string | null {
  if (provider.credentialsJson?.trim()) return provider.credentialsJson;
  try {
    const onDisk = readFileSync(codexAuthFile(provider.configDir), "utf8").trim();
    return onDisk || null;
  } catch {
    return null;
  }
}

/** True when the JSON blob looks like a real Codex `auth.json` (ChatGPT login or API key). */
export function codexAuthLooksValid(credentialsJson: string | null | undefined): boolean {
  if (!credentialsJson?.trim()) return false;
  try {
    const parsed = JSON.parse(credentialsJson) as {
      tokens?: { access_token?: string; id_token?: string; refresh_token?: string };
      OPENAI_API_KEY?: string | null;
    };
    if (parsed.OPENAI_API_KEY?.trim()) return true;
    return !!(parsed.tokens?.access_token || parsed.tokens?.id_token || parsed.tokens?.refresh_token);
  } catch {
    return false;
  }
}

/**
 * Expiry (epoch ms) of a Codex login, read from the `exp` claim of its JWT.
 *
 * Codex's auth.json has no plain `expiresAt` like Claude's credentials do, but the access
 * and id tokens are JWTs. Returns 0 when nothing usable is present — callers treat that as
 * "unknown", not "expired".
 */
export function extractCodexExpiresAt(credentialsJson: string | null | undefined): number {
  if (!credentialsJson) return 0;
  try {
    const parsed = JSON.parse(credentialsJson) as { tokens?: { access_token?: string; id_token?: string } };
    for (const token of [parsed.tokens?.access_token, parsed.tokens?.id_token]) {
      const exp = jwtExp(token);
      if (exp) return exp;
    }
    return 0;
  } catch {
    return 0;
  }
}

function jwtExp(token?: string): number {
  if (!token) return 0;
  const segments = token.split(".");
  if (segments.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Codex's phrasing for a spent plan window / 429. Mirrors `detectUsageLimit` for Claude.
 *
 * A match throttles the whole provider for as long as an hour, so the patterns have to be
 * narrow enough that the *agent's own prose* can't trip them. They used to include a bare
 * `rate limit`, a bare `try again in …` and a bare `429`, which meant a task whose agent
 * wrote "added rate limiting to the API" or printed a diff touching line 429 took the
 * provider out of rotation. Every pattern now needs limit-specific context; callers should
 * additionally run this over Codex's *diagnostics* only (see `CodexSignalTracker`), not over
 * the transcript.
 */
export function detectCodexUsageLimit(text: string): string | null {
  const patterns: RegExp[] = [
    /you'?ve (?:hit|reached) your usage limit[^.\n]*/i,
    /usage limit reached[^.\n]*/i,
    /(?:usage|rate) limits? (?:exceeded|reached)[^.\n]*/i,
    /rate[- ]?limit(?:ed|ing|s)?\b[^\n]{0,80}?\b(?:exceeded|reached|retry|retry-after|resets? (?:at|in)|try again)\b[^.\n]*/i,
    /\byou (?:are|'re) being rate[- ]?limited[^.\n]*/i,
    /too many requests[^.\n]*/i,
    /(?:quota|credit(?:s)?|balance) (?:exceeded|exhausted|depleted)[^.\n]*/i,
    /(?:limit|quota)[^\n]{0,60}?try again (?:in|later|after)[^.\n]*/i,
    /\b(?:status|code|http|error)\W{0,10}429\b[^\n]*/i,
    /\b429\b[^\n]{0,40}too many requests[^\n]*/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[0].trim();
  }
  return null;
}

/** Codex's phrasing for "your login is no longer good". */
export function detectCodexAuthError(text: string): boolean {
  return /not logged in|please (?:run )?`?codex login`?|unauthorized|401|invalid[_ ]api[_ ]key|authentication (?:failed|error)|token (?:has )?expired/i.test(text);
}

/**
 * How seriously to take a Codex error line.
 *
 * Codex is chatty about problems it is already handling itself, and treating all of that
 * chatter as "the run failed" is what produced the nonsensical `Task failed: Codex CLI
 * exited with code 0`. Three buckets:
 *
 * - `recoverable` — the model asked for something impossible and got told so. The canonical
 *   case is `apply_patch verification failed` / `invalid patch`: Codex hands the error back
 *   to the model, which reads the file again and retries. Nothing is wrong with the run.
 * - `transient` — the transport or a Codex sub-process wobbled: WebSocket resets, DNS
 *   `Try again`, idle timeouts, the model-list refresher timing out. Retrying the whole
 *   `codex exec` is the right response, not failing the task.
 * - `fatal` — anything else (bad auth, bad flags, a real model refusal).
 */
export type CodexFailureKind = "recoverable" | "transient" | "fatal";

/** Errors Codex feeds back to the model, which then fixes its own mistake and carries on. */
const RECOVERABLE_PATTERNS: RegExp[] = [
  /apply_patch/i,
  /invalid patch/i,
  /failed to find expected lines/i,
  /multiple operations target/i,
  /patch (?:application|apply) failed/i,
  /file (?:was )?(?:not found|modified) since/i,
  /no such file or directory/i,
  /command (?:timed out|failed with exit code)/i,
];

/** Network / sub-process wobbles that a fresh attempt usually gets past. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /websocket/i,
  /connection reset/i,
  /stream (?:disconnected|closed|error|ended)/i,
  /disconnected before completion/i,
  /reconnecting\b/i,
  /failed to lookup address information/i,
  /(?:temporary|temporarily) (?:failure|unavailable)/i,
  /\bEAI_AGAIN\b|\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEPIPE\b|\bENETUNREACH\b|\bEHOSTUNREACH\b/,
  /idle timeout/i,
  /timeout waiting for child process/i,
  /failed to refresh available models/i,
  /failed to connect to websocket/i,
  /socket hang ?up/i,
  /unexpected eof/i,
  /request timed out/i,
  /\b5\d{2}\b\s*(?:bad gateway|service unavailable|gateway timeout|internal server error)/i,
  /bad gateway|service unavailable|gateway timeout/i,
  /server (?:had an error|error) while processing/i,
  /stream ended unexpectedly/i,
];

/**
 * Classify an error string from Codex's stdout events, its stderr tracing, or a wrapper
 * message we built ourselves. Order matters: a line can mention both a patch failure and a
 * timeout, and the recoverable reading is the safer of the two (it doesn't burn a retry).
 */
export function classifyCodexFailure(text: string | null | undefined): CodexFailureKind {
  if (!text?.trim()) return "fatal";
  if (RECOVERABLE_PATTERNS.some((re) => re.test(text))) return "recoverable";
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) return "transient";
  return "fatal";
}

/**
 * True for Codex's `tracing` diagnostics and progress chatter — the `2026-01-01T00:00:00Z
 * ERROR codex_core::…` lines and `Reconnecting... 2/5 (…)`. They arrive on stderr, they are
 * not the run failing, and logging them at `error` level makes every task look broken.
 */
export function isCodexNoiseLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^\s*Reconnecting\.{0,3}\s*\d+\/\d+/i.test(trimmed)) return true;
  if (/^\s*Reading additional input from stdin/i.test(trimmed)) return true;
  return codexTraceLevel(trimmed) !== null;
}

/**
 * The severity word out of a `tracing` line (`… ERROR codex_core::…`), or null when the line
 * isn't one. Used to keep Codex's routine `INFO`/`DEBUG` chatter out of the error channel
 * without also hiding the diagnostics that do matter.
 */
export function codexTraceLevel(text: string): "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | null {
  // ISO timestamp + level + rust module path: the tracing subscriber's default format.
  const match = text
    .trim()
    .match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:/i);
  return match ? (match[1].toUpperCase() as "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR") : null;
}

/**
 * Strip the tracing prefix off a Codex log line so classification sees the message itself
 * (`error=apply_patch verification failed: …` rather than the timestamp and module path).
 */
export function stripCodexLogPrefix(text: string): string {
  return text
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+?:\s+/i, "")
    .replace(/^error=/i, "")
    .trim();
}

/**
 * Re-assembles whole lines out of the arbitrary chunks a child process' stream delivers.
 *
 * A `data` event is not a line: Codex's stderr regularly splits
 * `… ERROR codex_core::…: error=apply_patch verification failed: …` across two chunks, and
 * classifying half a line reads a *recoverable* patch error (or a *transient* reconnect) as
 * fatal — which is how healthy runs ended up with red errors in the task log and, worse,
 * failed instead of being retried. Both of Codex's streams go through this.
 */
export interface CodexLineBuffer {
  /** Whole lines contained in `chunk`, keeping any trailing partial line for next time. */
  push(chunk: string): string[];
  /** The leftover partial line (if any), emptying the buffer. Call once the stream ends. */
  flush(): string | null;
}

export function createLineBuffer(): CodexLineBuffer {
  let pending = "";
  return {
    push(chunk: string): string[] {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      return lines;
    },
    flush(): string | null {
      const rest = pending;
      pending = "";
      return rest.trim() ? rest : null;
    },
  };
}

/**
 * Children spawned for Codex that are still alive, so a worker shutdown doesn't leave a
 * detached `codex exec` (and the build/test commands it started) running forever.
 */
const liveCodexChildren = new Set<{ pid?: number }>();
let exitHooksInstalled = false;

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const killAll = () => {
    for (const child of liveCodexChildren) killCodexProcessTree(child, "SIGKILL");
    liveCodexChildren.clear();
  };
  process.once("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      killAll();
      // Don't swallow the signal: restore default behaviour and re-raise it.
      process.kill(process.pid, signal);
    });
  }
}

/** Remember a spawned Codex child until it exits, for the shutdown sweep above. */
export function trackCodexChild(child: { pid?: number; once?: (e: string, cb: () => void) => unknown }): void {
  if (!child.pid) return;
  installExitHooks();
  liveCodexChildren.add(child);
  child.once?.("close", () => liveCodexChildren.delete(child));
  child.once?.("error", () => liveCodexChildren.delete(child));
}

/**
 * Kill a Codex process *and everything it started*.
 *
 * Task runs use `--dangerously-bypass-approvals-and-sandbox`, so `codex exec` shells out to
 * installs, builds and test suites. Signalling only the `codex` pid on a timeout or a
 * cancelled task left those children running — burning CPU for the rest of the worker's life
 * and holding the workspace open while the worker tried to delete it. Codex is therefore
 * spawned `detached` (its own process group) and killed by group id, falling back to the
 * single process when the group signal isn't available (Windows, or the group already gone).
 */
export function killCodexProcessTree(
  child: { pid?: number; kill?: (signal: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const pid = child.pid;
  if (pid) {
    try {
      // Negative pid = "the whole process group", which is why we spawn detached.
      process.kill(-pid, signal);
      return;
    } catch {
      /* no group (or already dead) — fall through to the direct kill */
    }
  }
  try {
    child.kill?.(signal);
  } catch {
    /* already gone */
  }
}

export interface CodexUsage {
  /** Includes cached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** The cached part of `inputTokens` (telemetry). */
  cachedInputTokens?: number;
}

export interface CodexEvent {
  /** Text to surface in the task log, if any. */
  text?: string;
  /** Log level the text should be written at. */
  level: "info" | "error" | "system";
  /** True for the model's own message (as opposed to tool/reasoning chatter). */
  isAgentMessage: boolean;
  /** Cumulative token usage reported at the end of a turn. */
  usage?: CodexUsage;
  /**
   * Set only when Codex reported a *hard* failure. Recoverable (apply_patch) and transient
   * (WebSocket/DNS) errors leave this false — see `classifyCodexFailure`.
   */
  failed: boolean;
  /** Present on any error line, including the ones that don't set `failed`. */
  failureKind?: CodexFailureKind;
  /**
   * True for Codex talking about itself (error events, plain-text warnings, reconnect
   * chatter) as opposed to the transcript (the model's messages, tool output). Only
   * diagnostics are searched for usage limits — see `CodexSignalTracker` — because an agent
   * that merely writes about rate limiting must not throttle the provider.
   */
  isDiagnostic?: boolean;
  /**
   * Set on `turn.completed`. Proof the model finished a turn, which is what distinguishes
   * "reconnected and carried on" from "ran out of reconnects and exited 0".
   */
  turnCompleted?: boolean;
}

/**
 * Parse one line of `codex exec --json` output.
 *
 * Codex emits a JSONL thread-event stream. Only *completed* items are surfaced: the same
 * item also arrives as `item.started` / `item.updated` while it streams, and emitting those
 * too would triple every message in the task log. Field naming changed across Codex
 * versions (`item.item_type` vs `item.type`), so both are accepted.
 *
 * Returns null for lines that carry nothing worth logging, and falls back to emitting the
 * raw line when it isn't JSON at all (Codex prints plain-text warnings on stdout too).
 */
export function parseCodexEvent(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let event: {
    type?: string;
    msg?: { type?: string; message?: string };
    message?: string;
    error?: { message?: string } | string;
    item?: { type?: string; item_type?: string; text?: string; command?: string; aggregated_output?: string };
    usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  };
  try {
    event = JSON.parse(trimmed);
  } catch {
    // Not JSON: Codex prints plain-text warnings, reconnect progress and tracing lines on
    // stdout too. Keep them in the log, but never at "error" level and never as a failure —
    // "Reconnecting... 2/5" is Codex recovering, not Codex giving up.
    if (isCodexNoiseLine(trimmed)) {
      return {
        text: trimmed,
        level: codexLogLevelFor(trimmed),
        isAgentMessage: false,
        failed: false,
        failureKind: classifyCodexFailure(stripCodexLogPrefix(trimmed)),
        isDiagnostic: true,
      };
    }
    // Plain text on stdout is Codex speaking, not the model — including the plain-English
    // "You've hit your usage limit" it prints instead of a JSON error event.
    return { text: trimmed, level: "info", isAgentMessage: false, failed: false, isDiagnostic: true };
  }

  const type = event.type ?? event.msg?.type;

  if (type === "turn.completed" || type === "turn_complete") {
    const usage = event.usage;
    return {
      level: "system",
      isAgentMessage: false,
      failed: false,
      turnCompleted: true,
      usage: usage
        ? {
            inputTokens: (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
            outputTokens: usage.output_tokens ?? 0,
            cachedInputTokens: usage.cached_input_tokens ?? undefined,
          }
        : undefined,
    };
  }

  if (type === "error" || type === "turn.failed" || type === "turn_failed") {
    const message =
      (typeof event.error === "string" ? event.error : event.error?.message) ?? event.message ?? event.msg?.message;
    const text = message ?? "Codex reported an error";
    // A patch that didn't apply or a WebSocket that dropped is not the run failing — Codex
    // hands the first back to the model and reconnects on the second. Only genuinely fatal
    // errors set `failed`, so a run that recovered isn't reported as "exited with code 0".
    const failureKind = classifyCodexFailure(stripCodexLogPrefix(text));
    return {
      text,
      level: failureKind === "fatal" ? "error" : "system",
      isAgentMessage: false,
      failed: failureKind === "fatal",
      failureKind,
      isDiagnostic: true,
    };
  }

  // Only completed items produce log output — see the note above about started/updated.
  if (type && type !== "item.completed") return null;

  const item = event.item;
  if (!item) {
    const message = event.message ?? event.msg?.message;
    return message ? { text: message, level: "info", isAgentMessage: false, failed: false } : null;
  }

  const itemType = item.item_type ?? item.type ?? "";
  const isAgentMessage = itemType === "agent_message" || itemType === "assistant_message";
  const text = item.text ?? item.aggregated_output ?? item.command;
  if (!text) return null;

  return {
    text: itemType === "command_execution" && item.command ? `$ ${item.command}` : text,
    level: itemType === "command_execution" ? "system" : "info",
    isAgentMessage,
    failed: false,
  };
}

export interface CodexStderrLine {
  text: string;
  level: "error" | "system";
  failureKind?: CodexFailureKind;
}

/**
 * Split a stderr chunk into log lines with a sensible level.
 *
 * Codex writes its `tracing` output to stderr, so a completely healthy run still produces
 * `ERROR codex_core::tools::router: error=apply_patch verification failed: …` and
 * `ERROR codex_models_manager::manager: failed to refresh available models: …`. Logging all
 * of that at `error` level makes successful tasks look like disasters, so only genuinely
 * fatal lines keep that level.
 */
export function classifyCodexStderr(chunk: string): CodexStderrLine[] {
  return chunk
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .map((text) => ({ text, level: codexLogLevelFor(text), failureKind: classifyCodexFailure(stripCodexLogPrefix(text)) }));
}

/**
 * The task-log level a raw Codex output line deserves.
 *
 * `error` is reserved for lines that are both severe *and* unexplained: Codex's own `INFO`
 * chatter, its reconnect progress, and the `ERROR` lines for problems it recovers from
 * (apply_patch, WebSocket) all belong at `system` level, or every healthy run looks broken.
 */
function codexLogLevelFor(text: string): "error" | "system" {
  const failureKind = classifyCodexFailure(stripCodexLogPrefix(text));
  if (failureKind !== "fatal") return "system";
  const trace = codexTraceLevel(text);
  // Not a tracing line at all (e.g. `error: unknown flag --nope`) → take it at face value.
  if (trace === null) return "error";
  return trace === "ERROR" ? "error" : "system";
}

/**
 * How many times a `codex exec` invocation is re-spawned when the previous one died of a
 * transient transport problem. Codex already reconnects five times internally; by the time
 * it gives up the whole process is gone, so recovering means starting a fresh one.
 */
export const CODEX_MAX_ATTEMPTS = 3;

/** Backoff before re-spawning Codex after a transient failure (attempt is 1-indexed). */
export function codexRetryDelayMs(attempt: number): number {
  // 5s, 15s, 45s … capped so a long outage doesn't eat the whole task timeout in one sleep.
  return Math.min(5000 * 3 ** Math.max(0, attempt - 1), 60000);
}

/**
 * The note prepended to the prompt when a run is re-spawned after a transient failure.
 *
 * `codex exec` is one-shot, so a retry re-runs the same prompt — but the workspace still
 * holds whatever the dead attempt managed to write. Without this the model happily redoes
 * finished work or trips over its own half-applied edits.
 */
export function codexResumeNotice(attempt: number, reason: string): string {
  return [
    `[Automatic retry ${attempt} of ${CODEX_MAX_ATTEMPTS}]`,
    `A previous attempt at this task was interrupted by an infrastructure problem (${reason}).`,
    "It was not a problem with your work. Any files it already changed are still on disk in the workspace.",
    "Before doing anything else, inspect the working tree (e.g. `git status` and `git diff` in each repo) to see what",
    "is already done, then continue from there instead of starting over or reverting existing progress.",
  ].join("\n");
}

/** What one `codex exec` process left behind, as seen by the provider's stream handlers. */
export interface CodexRunSignals {
  /** Process exit status (null when it was killed by a signal). */
  exitCode: number | null;
  /** The agent printed the task-complete marker. */
  sawCompletionMarker: boolean;
  /**
   * A `turn.completed` arrived *after* the most recent transient problem — the model carried
   * on past the wobble rather than being cut off by it. A turn that completed *before* the
   * stream died doesn't count: the run still ended mid-task.
   */
  sawTurnCompleted: boolean;
  /** Fatal error messages, most recent last. */
  fatalErrors: string[];
  /** The most recent transient (transport) problem, if any. */
  lastTransient: string | null;
  /** A usage-limit phrase found in the non-transient output, if any. */
  limitMessage: string | null;
}

/** Cap on retained diagnostic lines: a long run must not grow a list forever. */
const MAX_TRACKED_DIAGNOSTICS = 200;

/**
 * Accumulates the signals of one `codex exec` run.
 *
 * This used to live inline in `CodexCliProvider` as half a dozen mutable locals plus an
 * unbounded array of *every* line the run produced, which caused two bugs worth calling out:
 *
 * - the usage-limit detector ran over the whole transcript, so an agent that merely *wrote
 *   about* rate limiting (or printed a `429`) throttled the provider for an hour. Only lines
 *   Codex itself flagged as a problem are considered here.
 * - a `turn.completed` seen at any point excused a later dropped stream, so a run that died
 *   half way through was reported as a success. A transient problem now invalidates the
 *   earlier turn; only a turn completed *after* it means Codex recovered.
 *
 * Pure and free of process plumbing, so the combinations can be unit-tested.
 */
export class CodexSignalTracker {
  private readonly fatalErrors: string[] = [];
  private readonly diagnostics: string[] = [];
  private lastTransient: string | null = null;
  private turnCompletedSinceTransient = false;
  private completionMarker = false;
  private recovered = 0;

  /** Number of recoverable tool errors (patch retries) Codex handled by itself. */
  get recoveredCount(): number {
    return this.recovered;
  }

  /** The agent printed `---TASK_COMPLETE---`. */
  markCompletionMarker(): void {
    this.completionMarker = true;
  }

  /** Feed a parsed stdout event. */
  event(event: CodexEvent): void {
    if (event.turnCompleted) {
      this.turnCompletedSinceTransient = true;
      // Codex got past whatever dropped earlier; stop holding it against the run.
      this.lastTransient = null;
    }
    this.record(event.failureKind, event.text, event.failed, event.isDiagnostic ?? false);
  }

  /** Feed a classified stderr line. */
  stderrLine(line: CodexStderrLine): void {
    // stderr carries Codex's tracing diagnostics; they never fail a run on their own, so a
    // fatal-looking line is remembered for context but not pushed into `fatalErrors`.
    this.record(line.failureKind, line.text, false, true);
  }

  private record(
    kind: CodexFailureKind | undefined,
    text: string | undefined,
    failed: boolean,
    isDiagnostic: boolean,
  ): void {
    if (!kind && !isDiagnostic) return;
    const message = stripCodexLogPrefix(text ?? "");
    if (kind === "recoverable") {
      this.recovered++;
    } else if (kind === "transient") {
      this.lastTransient = message || "connection lost";
      this.turnCompletedSinceTransient = false;
    } else if (failed) {
      this.fatalErrors.push(text ?? "Codex reported an error");
    }
    // Only Codex's own diagnostics are searched for usage limits — never the transcript, so
    // an agent that writes about rate limiting can't take the provider out of rotation.
    if (message) {
      this.diagnostics.push(message);
      if (this.diagnostics.length > MAX_TRACKED_DIAGNOSTICS) this.diagnostics.shift();
    }
  }

  /** Everything `decideCodexOutcome()` needs, once the process has exited. */
  signals(exitCode: number | null): CodexRunSignals {
    // Transport noise is excluded before looking for a usage limit: DNS failures say
    // "Try again", which would otherwise read as a plan reset and throttle the provider
    // for an hour over a network blip.
    const limitMessage = detectCodexUsageLimit(
      this.diagnostics.filter((line) => classifyCodexFailure(line) !== "transient").join("\n"),
    );
    return {
      exitCode,
      sawCompletionMarker: this.completionMarker,
      sawTurnCompleted: this.turnCompletedSinceTransient,
      fatalErrors: [...this.fatalErrors],
      lastTransient: this.lastTransient,
      limitMessage,
    };
  }
}

export interface CodexRunOutcome {
  success: boolean;
  /** Rate limited: the worker should throttle this provider and pick another. */
  shouldRetry: boolean;
  /** Re-spawning `codex exec` is worth a try. */
  transient: boolean;
  error?: string;
  /** The login is dead: the worker should hand the task to another provider. */
  authFailed?: boolean;
}

/**
 * Decide whether a finished `codex exec` succeeded — the rule that used to be a one-line
 * `code === 0 && !sawFailure` and produced `Task failed: Codex CLI exited with code 0`.
 *
 * Kept pure and separate from the process plumbing so the interesting combinations (exit 0
 * after the reconnect budget ran out; a recovered blip mid-run; a patch error in an
 * otherwise perfect run) can be unit-tested without spawning anything.
 */
export function decideCodexOutcome(signals: CodexRunSignals): CodexRunOutcome {
  const { exitCode, sawCompletionMarker, sawTurnCompleted, fatalErrors, lastTransient, limitMessage } = signals;

  // The completion marker rescues a run that did the work but exited badly afterwards.
  // Otherwise a clean exit is success — and a transient line only counts against the run
  // when no turn ever completed, since Codex also logs reconnects it recovered from.
  if (sawCompletionMarker || (exitCode === 0 && fatalErrors.length === 0 && (sawTurnCompleted || !lastTransient))) {
    return { success: true, shouldRetry: false, transient: false };
  }

  if (limitMessage) return { success: false, shouldRetry: true, transient: false, error: limitMessage };

  // Codex exits 0 even when its reconnect budget ran out, so "exited with code 0" is never
  // a useful message on its own — report the transport failure that actually stopped it.
  if (lastTransient && fatalErrors.length === 0) {
    return { success: false, shouldRetry: false, transient: true, error: lastTransient };
  }

  // An expired/revoked login. Matched over the fatal lines only (never the transcript or the
  // transport chatter), and never retried on the same connection — re-spawning can't fix it.
  const authLine = fatalErrors.find((e) => detectCodexAuthError(e));
  if (authLine) {
    return { success: false, shouldRetry: false, transient: false, authFailed: true, error: authLine };
  }

  const detail = fatalErrors.length
    ? fatalErrors[fatalErrors.length - 1]
    : `Codex CLI exited with code ${exitCode ?? "null"}`;
  return {
    success: false,
    shouldRetry: false,
    transient: classifyCodexFailure(stripCodexLogPrefix(detail)) === "transient",
    error: detail,
  };
}

/**
 * Translate this app's effort scale (`src/lib/effort.ts`) to Codex's.
 *
 * Codex only knows `minimal | low | medium | high`; our scale has two extra rungs above
 * `high`. Passing `xhigh`/`max` straight through makes Codex reject the config override and
 * fail the whole run, so they clamp to `high` — the closest thing Codex actually offers.
 */
export function codexReasoningEffort(effort?: string | null): string | null {
  switch (effort?.trim().toLowerCase()) {
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return null;
  }
}

/** Args shared by every `codex exec` invocation we make. */
export function codexExecArgs(opts: {
  /** Working directory for the agent. */
  cd?: string;
  model?: string;
  effort?: string;
  /** Full write + network access. Off for the read-only assistant helpers. */
  fullAccess?: boolean;
}): string[] {
  // The workspace root holds one clone per repo, so it isn't a git repo itself —
  // without --skip-git-repo-check Codex refuses to start there.
  const args = ["exec", "--json", "--skip-git-repo-check"];
  if (opts.fullAccess) args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("--sandbox", "read-only");
  if (opts.cd) args.push("--cd", opts.cd);
  if (opts.model) args.push("--model", opts.model);
  // Codex takes reasoning effort as a per-invocation config override, not a flag.
  const reasoning = codexReasoningEffort(opts.effort);
  if (reasoning) args.push("--config", `model_reasoning_effort="${reasoning}"`);
  return args;
}

/**
 * The command to spawn for Codex: the absolute path when we can find one, else the bare
 * name so the OS's own PATH lookup still gets a chance. Resolving it ourselves matters
 * because `codex` is frequently installed somewhere a service's PATH doesn't cover, which
 * is exactly the "Codex CLI not found" case users hit.
 */
export function codexCommand(): string {
  return findCodexBinary() ?? "codex";
}

export interface RunCodexTextOptions {
  configDir?: string | null;
  model?: string;
  credentialsJson?: string | null;
  timeoutMs?: number;
  cwd?: string;
  /** Extra `codex exec` flags placed before the prompt, e.g. MCP `--config` overrides. */
  extraArgs?: string[];
}

/** Marker on errors a fresh `codex exec` has a real chance of getting past. */
class CodexTransientError extends Error {
  readonly transient = true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One-shot, read-only Codex call that resolves to the agent's final message.
 *
 * This is the Codex counterpart to the `runWithCli` helpers used by the assistant routes
 * (suggest title, decompose, diagnose, Slack chat, …): no tools that can touch the repo,
 * no streaming, just text back.
 *
 * A WebSocket reset or a DNS `Try again` is retried with backoff rather than surfaced —
 * these helpers back UI buttons, and a blank "suggest title" because ChatGPT's socket
 * blinked is a worse outcome than waiting a few seconds.
 */
export async function runCodexText(prompt: string, opts: RunCodexTextOptions = {}): Promise<string> {
  if (opts.configDir && opts.credentialsJson) {
    try {
      writeCodexAuth(opts.configDir, opts.credentialsJson);
    } catch {
      /* fall through — Codex may still have a usable login on disk */
    }
  }

  // An empty prompt makes `codex exec` wait on stdin instead of answering, so it would
  // simply hang until the timeout. Say what's wrong straight away.
  if (!prompt.trim()) throw new Error("Refusing to run Codex with an empty prompt.");

  let lastError: unknown;
  for (let attempt = 1; attempt <= CODEX_MAX_ATTEMPTS; attempt++) {
    try {
      return await runCodexTextOnce(prompt, opts);
    } catch (err) {
      lastError = err;
      const transient = err instanceof CodexTransientError;
      if (!transient || attempt === CODEX_MAX_ATTEMPTS) break;
      await sleep(codexRetryDelayMs(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function runCodexTextOnce(prompt: string, opts: RunCodexTextOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [...codexExecArgs({ model: opts.model }), ...(opts.extraArgs ?? []), prompt];
    const child = spawn(codexCommand(), args, {
      cwd: opts.cwd ?? "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
      env: codexEnv(opts.configDir),
      // Own process group, so a timeout can take the whole tree down (see killCodexProcessTree).
      detached: true,
    });
    trackCodexChild(child);

    const messages: string[] = [];
    const all: string[] = [];
    const failures: string[] = [];
    const stdoutLines = createLineBuffer();
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killCodexProcessTree(child, "SIGTERM");
      setTimeout(() => killCodexProcessTree(child, "SIGKILL"), 5000).unref?.();
      // A hung stream is exactly what a fresh attempt fixes, so mark it retryable.
      reject(new CodexTransientError("Codex CLI timed out"));
    }, opts.timeoutMs ?? 120000);

    const consume = (line: string) => {
      const parsed = parseCodexEvent(line);
      if (parsed?.usage) {
        // Telemetry: credited to the traceLlmCall() span this helper call runs in, if any.
        reportLlmUsage({
          inputTokens: parsed.usage.inputTokens,
          outputTokens: parsed.usage.outputTokens,
          cacheReadTokens: parsed.usage.cachedInputTokens,
          responseModel: opts.model || undefined,
        });
      }
      if (parsed?.failureKind && parsed.failureKind !== "recoverable" && parsed.text) failures.push(parsed.text);
      if (!parsed?.text) return;
      // Transport chatter isn't an answer — keep it out of the text handed back to callers.
      if (parsed.failureKind) return;
      all.push(parsed.text);
      if (parsed.isAgentMessage) messages.push(parsed.text);
    };

    child.stdout.on("data", (d: Buffer) => {
      if (settled) return;
      stdoutLines.push(d.toString()).forEach(consume);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trailing = stdoutLines.flush();
      if (trailing) consume(trailing);

      // Prefer the last agent message; some prompts produce several turns of chatter.
      const answer = (messages.length ? messages[messages.length - 1] : all.join("\n")).trim();
      // Codex can exit non-zero (or exit 0 after a failed reconnect) having already produced
      // the answer we asked for. Throwing that away and showing the user an error would be
      // strictly worse than using it.
      if (answer && (code === 0 || messages.length > 0)) {
        resolve(answer);
        return;
      }

      const stderrFailures = classifyCodexStderr(stderr)
        .filter((l) => l.failureKind !== "recoverable")
        .map((l) => l.text);
      const detail = [...failures, ...stderrFailures].join("\n").trim() || stderr.trim();
      const message = detail || `Codex CLI exited with code ${code ?? "null"} without producing a response`;
      reject(
        classifyCodexFailure(stripCodexLogPrefix(message)) === "transient"
          ? new CodexTransientError(message)
          : new Error(message),
      );
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(err.code === "ENOENT" ? CODEX_NOT_FOUND_MESSAGE : `Failed to start Codex CLI: ${err.message}`));
    });
  });
}

export interface CodexLivenessResult {
  ok: boolean;
  error?: string;
  limitMessage?: string;
  isAuthError?: boolean;
  /** The binary isn't installed — an install problem, not an auth or capacity problem. */
  notInstalled?: boolean;
  /** The network wobbled rather than the provider being broken — worth another probe. */
  isTransient?: boolean;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

interface CodexRateLimitsResponse {
  rateLimits?: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
}

const APP_SERVER_TIMEOUT_MS = 10000;

/**
 * Read the ChatGPT subscription windows exposed by Codex app-server. This is deliberately
 * best-effort: an older CLI or an API-key-only login may not support account rate limits, and
 * that should not turn an otherwise healthy provider red.
 */
export function readCodexRateLimits(configDir?: string | null): Promise<CodexRateLimitSnapshot | null> {
  return new Promise((resolve) => {
    if (!findCodexBinary()) {
      resolve(null);
      return;
    }

    const child = spawn(codexCommand(), ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: codexEnv(configDir),
      detached: true,
    });
    trackCodexChild(child);
    let stdout = "";
    let settled = false;

    const settle = (result: CodexRateLimitSnapshot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killCodexProcessTree(child, "SIGTERM");
      resolve(result);
    };

    const timer = setTimeout(() => settle(null), APP_SERVER_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        if (!line) continue;

        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: CodexRateLimitsResponse;
            error?: { message?: string };
          };
          if (message.id !== 1) continue;
          if (message.error) {
            settle(null);
            return;
          }
          const result = message.result;
          const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits ?? null;
          settle(snapshot);
          return;
        } catch {
          // App-server stdout is expected to be JSONL; ignore an unfamiliar line and keep reading.
        }
      }
    });

    child.on("error", () => settle(null));
    child.on("close", () => settle(null));
    child.stdin.on("error", () => settle(null));

    child.stdin.write(`${JSON.stringify({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "claude_task_manager", title: "Claude Task Manager", version: "1.0.0" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 1 })}\n`);
  });
}

const LIVENESS_TIMEOUT_MS = 30000;
const LIVENESS_MAX_ATTEMPTS = 2;

/**
 * The Codex equivalent of the Claude liveness probe: ask the model for one word and see
 * whether it comes back. Distinguishes "binary missing", "login expired" and "out of
 * capacity", because the fix for each is completely different.
 *
 * A dropped WebSocket is none of those, so it gets one more attempt before the health page
 * is allowed to paint the provider red (and, through it, take the provider out of the smart
 * picker's rotation over a five-second network blip).
 */
export async function probeCodexLiveness(configDir?: string | null, model?: string): Promise<CodexLivenessResult> {
  let last: CodexLivenessResult = { ok: false, error: "Liveness check did not run" };
  for (let attempt = 1; attempt <= LIVENESS_MAX_ATTEMPTS; attempt++) {
    last = await probeCodexLivenessOnce(configDir, model);
    if (last.ok || !last.isTransient) return last;
    if (attempt < LIVENESS_MAX_ATTEMPTS) await sleep(2000);
  }
  return last;
}

function probeCodexLivenessOnce(configDir?: string | null, model?: string): Promise<CodexLivenessResult> {
  return new Promise((resolve) => {
    if (!findCodexBinary()) {
      resolve({ ok: false, error: CODEX_NOT_FOUND_MESSAGE, notInstalled: true });
      return;
    }

    const args = [...codexExecArgs({ model }), "Reply with the single word OK."];
    const child = spawn(codexCommand(), args, {
      cwd: "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
      env: codexEnv(configDir),
      detached: true,
    });
    trackCodexChild(child);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: CodexLivenessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killCodexProcessTree(child, "SIGTERM");
      setTimeout(() => killCodexProcessTree(child, "SIGKILL"), 5000).unref?.();
      settle({ ok: false, error: "Liveness check timed out after 30s", isTransient: true });
    }, LIVENESS_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      const combined = `${stdout}\n${stderr}`.trim();
      const sawMessage = stdout
        .split("\n")
        .map(parseCodexEvent)
        .some((e) => e?.isAgentMessage && !!e.text);
      // The model answered — a non-zero exit afterwards (or transport noise on stderr)
      // doesn't change the fact that this login can reach the model.
      if (sawMessage) {
        settle({ ok: true });
        return;
      }
      const limitMessage = detectCodexUsageLimit(combined);
      // Auth phrasings are matched against the *fatal* lines only: `detectCodexAuthError`
      // trips on a bare "401", and Codex's reconnect chatter is full of numbers.
      const fatalOnly = classifyCodexStderr(combined)
        .filter((l) => l.failureKind === "fatal")
        .map((l) => l.text)
        .join("\n");
      const isAuthError = !limitMessage && detectCodexAuthError(fatalOnly);
      const isTransient =
        !limitMessage && !isAuthError && classifyCodexFailure(stripCodexLogPrefix(combined)) === "transient";
      settle({
        ok: false,
        error: isAuthError
          ? "Codex login has expired. Re-paste ~/.codex/auth.json in Settings → AI Providers."
          : isTransient
            ? `Could not reach Codex (network problem): ${combined.split("\n").slice(-1)[0] ?? combined}`
            : limitMessage ?? (combined || `Codex CLI exited with code ${code ?? "null"}`),
        limitMessage: limitMessage ?? undefined,
        isAuthError: isAuthError || undefined,
        isTransient: isTransient || undefined,
      });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(
        err.code === "ENOENT"
          ? { ok: false, error: CODEX_NOT_FOUND_MESSAGE, notInstalled: true }
          : {
              ok: false,
              error: `Failed to start Codex CLI: ${err.message}`,
              // EAGAIN/EMFILE mean the host was momentarily out of process slots or fds.
              isTransient: err.code === "EAGAIN" || err.code === "EMFILE" || undefined,
            },
      );
    });
  });
}
