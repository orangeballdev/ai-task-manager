import { NextRequest, NextResponse } from "next/server";
import { prisma, getDbPath } from "@/lib/db";
import { markRestoreCompleted, restartForRestore } from "@/lib/restart-signal";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

const MAX_RESTORE_SIZE = 500 * 1024 * 1024; // 500 MB
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf-8");

// GET /api/settings/backup — download a consistent snapshot of the SQLite database.
export async function GET() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    return NextResponse.json({ error: "Database file not found" }, { status: 404 });
  }

  const tmpPath = path.join(os.tmpdir(), `backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    // Use SQLite's online backup API (via a read-only handle) so the snapshot is
    // consistent even if the app or worker is mid-write when this runs.
    const source = new Database(dbPath, { readonly: true });
    try {
      await source.backup(tmpPath);
    } finally {
      source.close();
    }

    const buffer = await fs.promises.readFile(tmpPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="task-manager-backup-${stamp}.db"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create backup" },
      { status: 500 },
    );
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

// POST /api/settings/backup — restore the database from an uploaded SQLite file.
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_RESTORE_SIZE) {
    return NextResponse.json({ error: "File exceeds 500 MB limit" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length < 16 || !buffer.subarray(0, 16).equals(SQLITE_HEADER)) {
    return NextResponse.json({ error: "Uploaded file is not a valid SQLite database" }, { status: 400 });
  }

  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  const tmpPath = path.join(dir, `.restore-upload-${Date.now()}.db`);
  const safetyPath = `${dbPath}.pre-restore-backup`;

  try {
    await fs.promises.writeFile(tmpPath, buffer);

    // Confirm the upload is a structurally valid, openable SQLite database. We
    // deliberately don't run a full `quick_check`/`integrity_check` here — those
    // can flag pre-existing, harmless index quirks (e.g. from an unclean prior
    // shutdown) that would otherwise block restoring an otherwise-valid backup.
    const check = new Database(tmpPath, { readonly: true });
    try {
      check.prepare("SELECT count(*) FROM sqlite_master").get();
    } catch {
      return NextResponse.json({ error: "Uploaded file is not a readable SQLite database" }, { status: 400 });
    } finally {
      check.close();
    }

    // Keep a safety copy of the current DB in case something goes wrong.
    if (fs.existsSync(dbPath)) {
      await fs.promises.copyFile(dbPath, safetyPath);
    }

    // Close the current connection so the file can be safely replaced. Prisma
    // reconnects lazily on the next query, so this doesn't require a restart
    // of this process — though the separate worker process should still be
    // restarted so it picks up the restored data instead of its stale handle.
    await prisma.$disconnect();

    // Drop any WAL/SHM sidecar files so stale write-ahead data isn't replayed onto the restored db.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`;
      if (fs.existsSync(sidecar)) await fs.promises.unlink(sidecar).catch(() => {});
    }

    await fs.promises.copyFile(tmpPath, dbPath);

    // Signal every process sharing the data volume (this app, the worker, and the
    // integrations process) that a restore just completed. The worker and
    // integrations processes notice on their next poll and restart themselves;
    // this process restarts itself below, once the response below has flushed.
    // Docker's `restart: unless-stopped` policy (see docker-compose.yml) then
    // relaunches everything automatically with a fresh, non-stale DB connection.
    markRestoreCompleted();
    setTimeout(() => restartForRestore("Backup restore completed"), 500);

    return NextResponse.json({
      ok: true,
      warning:
        "Database restored. The app and worker will restart themselves automatically to pick up the new data " +
        "(a few seconds of downtime is expected).",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Restore failed" },
      { status: 500 },
    );
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}
