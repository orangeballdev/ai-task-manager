import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImageFiles, pastedImageName } from "../pasted-images";

const png = { name: "image.png", type: "image/png" };
const pdf = { name: "doc.pdf", type: "application/pdf" };

test("extractImageFiles returns images from files", () => {
  assert.deepEqual(extractImageFiles({ files: [png, pdf], getData: () => "" }), [png]);
});

test("extractImageFiles falls back to items", () => {
  const items = [
    { kind: "string", type: "text/html", getAsFile: () => null },
    { kind: "file", type: "image/png", getAsFile: () => png },
  ];
  assert.deepEqual(extractImageFiles({ files: [], items, getData: () => "" }), [png]);
});

test("extractImageFiles leaves text pastes alone", () => {
  assert.deepEqual(extractImageFiles({ files: [png], getData: () => "hello" }), []);
  assert.deepEqual(extractImageFiles({ files: [png], getData: () => "hello" }, { ignoreWhenText: false }), [png]);
});

test("extractImageFiles handles empty input", () => {
  assert.deepEqual(extractImageFiles(null), []);
  assert.deepEqual(extractImageFiles({ files: [pdf], getData: () => "" }), []);
});

test("pastedImageName renames generic clipboard names", () => {
  const now = new Date(2026, 9, 29, 9, 5, 7);
  assert.equal(pastedImageName(png, now), "screenshot-2026-10-29-090507.png");
  assert.equal(pastedImageName(png, now, 1), "screenshot-2026-10-29-090507-2.png");
  assert.equal(pastedImageName({ name: "", type: "image/jpeg" }, now), "screenshot-2026-10-29-090507.jpg");
  assert.equal(pastedImageName({ name: "mockup.png", type: "image/png" }, now), "mockup.png");
});
