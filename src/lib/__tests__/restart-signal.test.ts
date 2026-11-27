import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  shouldRestart,
  markRestoreCompleted,
  readRestoreSignal,
  isRestartPending,
  getRestartSignalPath,
} from "../restart-signal";

test("shouldRestart is false when no restore has happened", () => {
  assert.equal(shouldRestart(null, Date.now()), false);
});

test("shouldRestart is false when the restore predates process start", () => {
  const startedAt = Date.now();
  assert.equal(shouldRestart(startedAt - 1000, startedAt), false);
  assert.equal(shouldRestart(startedAt, startedAt), false); // exactly equal — not "after"
});

test("shouldRestart is true when a restore completed after process start", () => {
  const startedAt = Date.now();
  assert.equal(shouldRestart(startedAt + 1, startedAt), true);
});

test("getRestartSignalPath places the signal file next to the db file", () => {
  assert.equal(getRestartSignalPath("/data/dev.db"), path.join("/data", ".restore-signal"));
});

test("markRestoreCompleted + readRestoreSignal round-trip through a real file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-signal-test-"));
  const dbPath = path.join(dir, "dev.db");
  try {
    assert.equal(readRestoreSignal(dbPath), null); // nothing written yet

    markRestoreCompleted(dbPath);
    const restoredAt = readRestoreSignal(dbPath);
    assert.ok(typeof restoredAt === "number" && Number.isFinite(restoredAt));

    // Written just now, so any process that started earlier should see a pending restart.
    assert.equal(isRestartPending(dbPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRestoreSignal tolerates garbage content instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-signal-test-"));
  const dbPath = path.join(dir, "dev.db");
  try {
    fs.writeFileSync(getRestartSignalPath(dbPath), "not-a-number");
    assert.equal(readRestoreSignal(dbPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
