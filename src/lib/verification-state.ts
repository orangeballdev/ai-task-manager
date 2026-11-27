/**
 * Verification ledger — remembers which expensive project-wide checks (build,
 * lint, typecheck, test) an agent already ran inside a task's workspace, and
 * whether the workspace has changed since.
 *
 * Why: when a task resumes (retry, throttle, review iteration) the workspace is
 * reused but the agent starts a fresh session with no memory of it, so it
 * re-runs `npm run build` / `npm run lint` from scratch every single time. On a
 * big repo that is minutes of wall clock and a lot of tokens spent re-reading
 * output it has already seen. The ledger lets the resume prompt say "lint
 * already passed on exactly this tree — don't run it again".
 *
 * Recording happens where commands are actually executed, so it needs no
 * cooperation from the agent:
 *   - `CliProvider` pairs Bash `tool_use` blocks with their `tool_result`
 *   - `executeTool()` wraps the bash tool for the API/OpenAI/PKI providers
 *
 * Everything here is best-effort: any failure (no git, unreadable file, racing
 * writes) degrades to "no record", which just means the agent re-runs the check
 * exactly as it does today.
 */
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const FILE_NAME = ".verification.json";
const MAX_ENTRIES = 24;
/** Untracked files are hashed by content; skip anything larger than this. */
const MAX_UNTRACKED_BYTES = 256_000;
const MAX_UNTRACKED_FILES = 200;

export interface VerificationEntry {
  /** The check as it was run, e.g. "npm run build". */
  command: string;
  status: "passed" | "failed";
  /** ISO timestamp of when it finished. */
  at: string;
  /** Hash of the whole workspace's git state at that moment. */
  fingerprint: string;
  /** repo dir name -> HEAD sha when the check ran, for human-readable output. */
  repoHeads: Record<string, string>;
}

/**
 * Commands worth remembering: whole-project checks that are slow to re-run.
 * Deliberately narrow — a targeted `npm test -- src/foo` or a one-off `tsc`
 * on a single file tells us nothing about the project as a whole, and claiming
 * otherwise would be worse than saying nothing.
 */
const VERIFICATION_PATTERNS: RegExp[] = [
  // JS/TS package scripts: npm/pnpm/yarn/bun run <build|lint|test|typecheck|...>
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|lint|typecheck|type-check|types|test|tests|check|verify|ci)\b/i,
  // Direct tool invocations
  /^(?:npx\s+)?tsc\b/i,
  /^(?:npx\s+)?eslint\b/i,
  /^(?:npx\s+)?(?:next|vite|webpack|rollup|turbo)\s+build\b/i,
  /^(?:npx\s+)?(?:jest|vitest|playwright|mocha)\b/i,
  // Other ecosystems
  /^cargo\s+(?:build|check|clippy|test)\b/i,
  /^go\s+(?:build|vet|test)\b/i,
  /^(?:python\s+-m\s+)?(?:pytest|mypy|ruff|flake8|tox)\b/i,
  /^(?:mvn|gradle|\.\/gradlew)\s+/i,
  /^make\s+(?:build|lint|test|check|ci)\b/i,
];

/** Split a shell command into the segments a `&&`/`;`/`||` chain would run. */
function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pull the project-wide verification commands out of a shell invocation.
 * Handles the common `cd repo && npm run build` shape by testing each segment,
 * and drops anything that looks scoped to specific files/paths.
 */
export function extractVerificationCommands(command: string): string[] {
  const found: string[] = [];
  for (const rawSegment of splitSegments(command)) {
    // Strip env-var prefixes ("CI=1 npm run build") and leading time/nice wrappers.
    const segment = rawSegment
      .replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/i, "")
      .replace(/^(?:time|nice(?:\s+-n\s*-?\d+)?)\s+/i, "")
      .trim();
    if (!segment) continue;
    if (!VERIFICATION_PATTERNS.some((re) => re.test(segment))) continue;
    // A check aimed at specific paths says nothing about the whole project.
    if (/\s(?:\.\/|\.\.\/|src\/|app\/|lib\/|tests?\/)\S/.test(segment)) continue;
    if (/\S+\.(?:ts|tsx|js|jsx|py|go|rs|java)\b/.test(segment)) continue;
    if (/--(?:watch|help|version)\b/.test(segment)) continue;
    found.push(segment.replace(/\s+/g, " "));
  }
  return [...new Set(found)];
}

function statePath(workspacePath: string): string {
  return path.join(workspacePath, FILE_NAME);
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Repo directories (depth 1) inside a workspace, sorted for stable hashing. */
function repoDirs(workspacePath: string): string[] {
  try {
    return fs
      .readdirSync(workspacePath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(workspacePath, e.name, ".git")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface WorkspaceState {
  fingerprint: string;
  repoHeads: Record<string, string>;
}

/**
 * Hash the exact content state of every repo in the workspace: HEAD, the full
 * uncommitted diff, and the contents of untracked-but-not-ignored files. Two
 * runs with the same fingerprint are looking at byte-identical source, so a
 * check that passed under one is still valid under the other.
 *
 * Ignored files (node_modules, build output) are excluded by `--porcelain -uall`,
 * which is what we want — they don't change whether lint or tsc would pass.
 */
export async function computeWorkspaceState(workspacePath: string): Promise<WorkspaceState | null> {
  const dirs = repoDirs(workspacePath);
  if (dirs.length === 0) return null;

  const hash = crypto.createHash("sha256");
  const repoHeads: Record<string, string> = {};

  for (const dir of dirs) {
    const repoDir = path.join(workspacePath, dir);
    hash.update(`repo:${dir}\n`);

    let head = "";
    try {
      head = (await git(repoDir, ["rev-parse", "HEAD"])).trim();
    } catch {
      head = "no-head";
    }
    repoHeads[dir] = head;
    hash.update(`head:${head}\n`);

    let porcelain = "";
    try {
      porcelain = await git(repoDir, ["status", "--porcelain", "-uall"]);
    } catch {
      // Can't read the repo state — poison the hash so nothing ever matches it.
      hash.update(`status:unreadable:${Date.now()}\n`);
      continue;
    }
    hash.update(`status:${porcelain}`);

    try {
      hash.update(`diff:${head === "no-head" ? await git(repoDir, ["diff"]) : await git(repoDir, ["diff", "HEAD"])}`);
    } catch {
      hash.update(`diff:unreadable:${Date.now()}\n`);
    }

    // `git diff` covers tracked files only, so hash untracked file contents too —
    // otherwise editing a brand-new file would look like "nothing changed".
    const untracked = porcelain
      .split("\n")
      .filter((l) => l.startsWith("?? "))
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED_FILES);
    for (const rel of untracked) {
      const abs = path.join(repoDir, rel);
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_UNTRACKED_BYTES) {
          hash.update(`untracked:${rel}:size:${stat.size}:${stat.mtimeMs}\n`);
          continue;
        }
        hash.update(`untracked:${rel}:`);
        hash.update(fs.readFileSync(abs));
        hash.update("\n");
      } catch {
        hash.update(`untracked:${rel}:unreadable\n`);
      }
    }
  }

  return { fingerprint: hash.digest("hex"), repoHeads };
}

export function readVerifications(workspacePath: string): VerificationEntry[] {
  try {
    const raw = fs.readFileSync(statePath(workspacePath), "utf8");
    const parsed = JSON.parse(raw) as { entries?: VerificationEntry[] };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((e) => e && typeof e.command === "string" && typeof e.fingerprint === "string");
  } catch {
    return [];
  }
}

export function clearVerifications(workspacePath: string): void {
  try {
    fs.rmSync(statePath(workspacePath), { force: true });
  } catch { /* best effort */ }
}

// Recording is fire-and-forget from stream handlers, so serialize writes through
// a promise chain — two checks finishing back to back must not clobber each other.
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Record the outcome of a shell command, if it was a project-wide check.
 * Safe to call for every command the agent runs — non-verification commands
 * are ignored cheaply, before any git work happens.
 */
export function recordCommandResult(workspacePath: string | undefined, command: string, ok: boolean): void {
  if (!workspacePath) return;
  const commands = extractVerificationCommands(command);
  if (commands.length === 0) return;

  writeQueue = writeQueue
    .then(async () => {
      const state = await computeWorkspaceState(workspacePath);
      if (!state) return;
      const existing = readVerifications(workspacePath);
      const at = new Date().toISOString();
      const kept = existing.filter((e) => !commands.includes(e.command));
      const added: VerificationEntry[] = commands.map((command) => ({
        command,
        status: ok ? "passed" : "failed",
        at,
        fingerprint: state.fingerprint,
        repoHeads: state.repoHeads,
      }));
      const entries = [...kept, ...added].slice(-MAX_ENTRIES);
      fs.writeFileSync(statePath(workspacePath), JSON.stringify({ entries }, null, 2));
    })
    .catch(() => { /* best effort — a missing record just means the agent re-runs it */ });
}

/** Await any in-flight ledger writes. Exported for tests. */
export async function flushVerificationWrites(): Promise<void> {
  await writeQueue.catch(() => {});
}

/**
 * Markdown for the resume prompt describing what has already been verified.
 * Returns "" when there's nothing useful to say, so callers can inline it.
 */
export async function buildVerificationSection(workspacePath: string): Promise<string> {
  const entries = readVerifications(workspacePath);
  if (entries.length === 0) return "";

  const state = await computeWorkspaceState(workspacePath);
  const currentFingerprint = state?.fingerprint;

  const lines: string[] = [];
  let anyClean = false;
  for (const entry of entries) {
    if (entry.status === "failed") {
      lines.push(`- \`${entry.command}\` — was FAILING when the previous run stopped. Fixing it is part of the remaining work.`);
      continue;
    }
    if (currentFingerprint && entry.fingerprint === currentFingerprint) {
      anyClean = true;
      lines.push(`- \`${entry.command}\` — passed, and the source is byte-for-byte identical to when it ran. Do NOT run it again unless you change files.`);
    } else {
      const shas = Object.values(entry.repoHeads ?? {}).map((s) => s.slice(0, 7)).filter(Boolean).join(", ");
      lines.push(`- \`${entry.command}\` — passed${shas ? ` at ${shas}` : ""}, but files have changed since. Re-run it only if your changes could plausibly affect it, and prefer an incremental run over a clean rebuild.`);
    }
  }
  if (lines.length === 0) return "";

  return [
    "\n### Checks already run in this workspace",
    ...lines,
    anyClean
      ? "Full builds and full lint runs are expensive here — do not re-run a passing check \"just to be sure\"."
      : "Full builds and full lint runs are expensive here — verify once, at the end, rather than after each edit.",
    "",
  ].join("\n");
}
