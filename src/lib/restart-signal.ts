import fs from "fs";
import path from "path";

/**
 * Restoring a backup swaps the SQLite file out from under any already-open
 * connections (see src/app/api/settings/backup/route.ts). The app, worker, and
 * integrations processes each hold their own long-lived better-sqlite3 handle,
 * and in practice those don't reliably pick up the swapped-in data — historically
 * this meant the operator had to manually restart every process after a restore.
 *
 * In Docker (see docker-compose.yml) each of those runs in its own container
 * with `restart: unless-stopped`, so a process that voluntarily exits gets
 * relaunched automatically with a brand new connection. This module implements
 * that: the restore route drops a small signal file (holding a timestamp) next
 * to the database file, on the same shared volume all three containers mount,
 * and each process polls for a signal newer than its own start time to know it
 * should exit and let Docker bring it back up fresh.
 */

const SIGNAL_FILE_NAME = ".restore-signal";

/** Mirrors the DATABASE_URL resolution used by src/lib/db.ts and the worker. */
function resolveDbPath(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./data/dev.db";
  const filePath = rawUrl.startsWith("file:") ? rawUrl.slice(5) : rawUrl;
  return path.resolve(filePath);
}

export function getRestartSignalPath(dbPath: string = resolveDbPath()): string {
  return path.join(path.dirname(dbPath), SIGNAL_FILE_NAME);
}

/** Captured once, at module load — i.e. close to process start. */
export const PROCESS_STARTED_AT = Date.now();

/** Called by the restore route right after a backup has been applied. */
export function markRestoreCompleted(dbPath?: string): void {
  try {
    fs.writeFileSync(getRestartSignalPath(dbPath), String(Date.now()));
  } catch (err) {
    console.error("[restart-signal] Failed to write restore signal file:", err);
  }
}

/** Reads the signal file's timestamp, or null if it doesn't exist / is unreadable. */
export function readRestoreSignal(dbPath?: string): number | null {
  try {
    const raw = fs.readFileSync(getRestartSignalPath(dbPath), "utf-8");
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Pure predicate (easy to unit test): did a restore complete after this process started? */
export function shouldRestart(restoredAt: number | null, startedAt: number): boolean {
  return restoredAt !== null && restoredAt > startedAt;
}

/** True if a restore happened after this process booted, i.e. it's serving stale data. */
export function isRestartPending(dbPath?: string): boolean {
  return shouldRestart(readRestoreSignal(dbPath), PROCESS_STARTED_AT);
}

/**
 * Exit the process so Docker's `restart: unless-stopped` policy relaunches it
 * with a fresh DB connection. Only actually exits when NODE_ENV=production
 * (how the app/worker/integrations run under docker-compose) — in local dev
 * (`npm run dev`) there's no supervisor to bring the process back, so we just
 * log a reminder instead of taking the app down.
 */
export function restartForRestore(reason: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[restart-signal] ${reason} — restart this process manually to pick up the restored data ` +
        "(auto-restart only runs in production/Docker, see docker-compose.yml).",
    );
    return;
  }
  console.log(`[restart-signal] ${reason} — exiting so the container restarts with the restored data.`);
  process.exit(0);
}
