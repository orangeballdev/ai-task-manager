import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { copyAttachmentsToWorkspace, getAttachmentsDir, resolveAttachmentPath } from "../attachments";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("getAttachmentsDir honours ATTACHMENTS_PATH and falls back to <cwd>/data/attachments", () => {
  const prev = process.env.ATTACHMENTS_PATH;
  try {
    process.env.ATTACHMENTS_PATH = "/data/attachments";
    assert.equal(getAttachmentsDir(), "/data/attachments");
    delete process.env.ATTACHMENTS_PATH;
    assert.equal(getAttachmentsDir(), path.join(process.cwd(), "data/attachments"));
  } finally {
    if (prev === undefined) delete process.env.ATTACHMENTS_PATH;
    else process.env.ATTACHMENTS_PATH = prev;
  }
});

test("resolveAttachmentPath uses the recorded path when it exists", () => {
  const dir = tmp("att-");
  const file = path.join(dir, "a.png");
  fs.writeFileSync(file, "x");
  assert.equal(resolveAttachmentPath({ path: file }, "/nowhere"), file);
});

test("resolveAttachmentPath falls back to the file name in the attachments dir", () => {
  // The upload was recorded by another process (e.g. the app container) at a path
  // this one can't see, but the same file is on the shared attachments volume.
  const dir = tmp("att-");
  fs.writeFileSync(path.join(dir, "abc.png"), "x");
  assert.equal(resolveAttachmentPath({ path: "/app/data/attachments/abc.png" }, dir), path.join(dir, "abc.png"));
  assert.equal(resolveAttachmentPath({ path: "/app/data/attachments/missing.png" }, dir), null);
});

test("copyAttachmentsToWorkspace copies into the root or the folder and reports missing files", () => {
  const store = tmp("att-store-");
  const ws = tmp("att-ws-");
  fs.writeFileSync(path.join(store, "id1.png"), "png");

  const atts = [
    { name: "screenshot-1.png", path: "/elsewhere/id1.png" },
    { name: "gone.png", path: "/elsewhere/id2.png" },
  ];

  const root = copyAttachmentsToWorkspace(atts, ws, "", store);
  assert.deepEqual(root.copied, ["screenshot-1.png"]);
  assert.equal(root.missing.length, 1);
  assert.equal(root.missing[0].name, "gone.png");
  assert.equal(fs.readFileSync(path.join(ws, "screenshot-1.png"), "utf8"), "png");

  const nested = copyAttachmentsToWorkspace(atts.slice(0, 1), ws, "/design/shots/", store);
  assert.deepEqual(nested.copied, [path.join("design", "shots", "screenshot-1.png")]);
  assert.ok(fs.existsSync(path.join(ws, "design/shots/screenshot-1.png")));
});

test("copyAttachmentsToWorkspace never writes outside the workspace", () => {
  const store = tmp("att-store-");
  const ws = tmp("att-ws-");
  fs.writeFileSync(path.join(store, "id1.png"), "png");
  const res = copyAttachmentsToWorkspace([{ name: "../../evil.png", path: path.join(store, "id1.png") }], ws, "../outside", store);
  assert.equal(res.targetDir, path.resolve(ws));
  assert.deepEqual(res.copied, ["evil.png"]);
  assert.ok(fs.existsSync(path.join(ws, "evil.png")));
});
