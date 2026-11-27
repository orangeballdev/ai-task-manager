import Database from "better-sqlite3";

/**
 * Enables WAL mode (+ a busy timeout) on the SQLite file at `resolvedPath` *before*
 * Prisma's better-sqlite3 adapter opens its own connection to it.
 *
 * Three separate processes point at the same SQLite file (see docker-compose.yml):
 * the Next.js app, the worker, and the integrations process. Each opens its own
 * independent connection via `new PrismaBetterSqlite3(...)` (src/lib/db.ts,
 * src/worker/index.ts, src/integrations/db.ts) — none of them configured the
 * journal mode, so SQLite defaulted to its rollback-journal mode. In that mode a
 * writer needs an exclusive lock over the *entire* file, so the worker's frequent
 * TaskLog inserts while streaming a running task's output would serialize behind
 * the app's log-polling reads (GET /api/tasks/[id]/logs/stream polls every 500ms —
 * see CLAUDE.md) and the kanban board's list polling, and vice versa. Under any
 * real concurrent load (a task running while its detail page or the board is open)
 * this is very likely the single biggest source of tasks "feeling" slow, and it
 * gets worse — not better — the more constrained the host is, which matches "it
 * might just be the server it's deployed on."
 *
 * WAL mode lets readers proceed concurrently with a single writer instead of
 * blocking each other. `busy_timeout` makes any lock contention that does still
 * happen (e.g. two writers) retry for a few seconds instead of immediately
 * throwing `SQLITE_BUSY`. `synchronous = NORMAL` is the standard pairing with WAL —
 * still durable across app crashes, only relaxes the fsync that guards against a
 * full OS-level power loss, which is an acceptable tradeoff for this workload.
 *
 * Opens a short-lived, separate better-sqlite3 connection to apply this
 * synchronously — journal_mode is persisted in the database file itself, so this
 * only needs to run once per file, but re-running it on every process start is
 * cheap and idempotent. Done synchronously (rather than via `prisma.$executeRawUnsafe`
 * after the client exists) so it's guaranteed to land before any other query the
 * calling process issues, with no ordering race to reason about.
 */
export function ensureSqliteWalMode(resolvedPath: string): void {
  try {
    const bootstrap = new Database(resolvedPath);
    bootstrap.pragma("journal_mode = WAL");
    bootstrap.pragma("busy_timeout = 5000");
    bootstrap.pragma("synchronous = NORMAL");
    bootstrap.close();
  } catch (err) {
    console.error(`Failed to configure SQLite pragmas for ${resolvedPath}:`, err);
  }
}
