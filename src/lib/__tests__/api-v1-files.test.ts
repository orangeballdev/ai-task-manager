import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// workspace.ts reads WORKSPACES_PATH at module load, so point it at a temp dir before
// importing the module under test.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-v1-files-"));
process.env.WORKSPACES_PATH = root;

const TASK = "task1";
const ws = path.join(root, TASK);
const outside = path.join(root, "secret.txt");

type Mod = typeof import("../api-v1-files");
let mod: Mod;

before(async () => {
  mod = await import("../api-v1-files");
  fs.mkdirSync(path.join(ws, "output", "nested"), { recursive: true });
  fs.writeFileSync(path.join(ws, "output", "findings.json"), '{"findings": []}');
  fs.writeFileSync(path.join(ws, "output", "nested", "deep.txt"), "deep");
  fs.writeFileSync(path.join(ws, "output", "blob.bin"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(outside, "top secret");
  // A sibling workspace whose name shares the task id as a prefix.
  fs.mkdirSync(path.join(root, `${TASK}-evil`), { recursive: true });
  fs.writeFileSync(path.join(root, `${TASK}-evil`, "x.txt"), "evil");
  fs.symlinkSync(outside, path.join(ws, "output", "link-out.txt"));
  fs.symlinkSync(root, path.join(ws, "output", "link-dir"));
  fs.symlinkSync(path.join(ws, "output", "findings.json"), path.join(ws, "output", "link-in.json"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveWorkspacePath rejects lexical escapes, including a same-prefix sibling", () => {
  assert.equal(mod.resolveWorkspacePath(TASK, "../secret.txt"), null);
  assert.equal(mod.resolveWorkspacePath(TASK, `../${TASK}-evil/x.txt`), null);
  assert.equal(mod.resolveWorkspacePath(TASK, "/etc/passwd"), null);
  assert.equal(mod.resolveWorkspacePath(TASK, "output/findings.json"), path.join(ws, "output", "findings.json"));
});

test("readWorkspaceFile returns text files inside the workspace", async () => {
  const r = await mod.readWorkspaceFile(TASK, "output/findings.json");
  assert.ok(r.ok);
  assert.equal(r.content, '{"findings": []}');
});

test("readWorkspaceFile refuses a symlink that points outside the workspace", async () => {
  const r = await mod.readWorkspaceFile(TASK, "output/link-out.txt");
  assert.deepEqual(r, { ok: false, reason: "not_found" });
  const viaDir = await mod.readWorkspaceFile(TASK, "output/link-dir/secret.txt");
  assert.deepEqual(viaDir, { ok: false, reason: "not_found" });
});

test("readWorkspaceFile follows a symlink that stays inside the workspace", async () => {
  const r = await mod.readWorkspaceFile(TASK, "output/link-in.json");
  assert.ok(r.ok);
  assert.equal(r.content, '{"findings": []}');
});

test("readWorkspaceFile flags directories, binaries and missing files", async () => {
  assert.deepEqual(await mod.readWorkspaceFile(TASK, "output"), { ok: false, reason: "is_directory" });
  assert.equal((await mod.readWorkspaceFile(TASK, "output/blob.bin")).ok, false);
  assert.deepEqual(await mod.readWorkspaceFile(TASK, "output/nope.txt"), { ok: false, reason: "not_found" });
});

test("listWorkspaceFiles refuses to list a directory reached through an escaping symlink", async () => {
  assert.equal(await mod.listWorkspaceFiles(TASK, "output/link-dir"), null);
  assert.equal(await mod.listWorkspaceFiles(TASK, ".."), null);
});

test("listWorkspaceFiles walks recursively without following or sizing escaping symlinks", async () => {
  const entries = await mod.listWorkspaceFiles(TASK, "output", true);
  assert.ok(entries);
  const paths = entries.map((e) => e.path).sort();
  assert.ok(paths.includes(path.join("output", "nested", "deep.txt")));
  assert.ok(!paths.some((p) => p.includes("secret")), "must not descend into link-dir");
  const linkOut = entries.find((e) => e.name === "link-out.txt");
  assert.ok(linkOut);
  assert.equal(linkOut.size, undefined);
});
