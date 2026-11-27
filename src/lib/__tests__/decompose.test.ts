/**
 * Unit tests for the "Split into subtasks" prompt and parser (src/lib/decompose.ts).
 *
 * Run with:
 *   npx tsx --test src/lib/__tests__/decompose.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECOMPOSE_SYSTEM_PROMPT,
  MAX_SUBTASKS,
  buildDecomposeUserMessage,
  parseSubtasks,
} from "../decompose";

const item = (n: number) => ({ title: `Task ${n}`, description: `Do thing ${n}`, context: "- ok" });

test("prompt states no numeric cap for the model to anchor on", () => {
  const msg = buildDecomposeUserMessage("T", "D");
  // Regression: "2–6" in the user message vs a cap of 4 made every split come back as 4;
  // a later "never more than 4" cap stopped long to-do lists being split properly.
  assert.doesNotMatch(msg, /2[–-]6/);
  assert.doesNotMatch(msg, /at most \d/);
  assert.doesNotMatch(DECOMPOSE_SYSTEM_PROMPT, /more than \d/);
  assert.match(DECOMPOSE_SYSTEM_PROMPT, /no fixed upper limit/);
});

test("prompt asks for to-do lists to be grouped without dropping items", () => {
  assert.match(DECOMPOSE_SYSTEM_PROMPT, /to-do list/);
  assert.match(DECOMPOSE_SYSTEM_PROMPT, /never drop an item/);
});

test("prompt does not anchor on a particular count", () => {
  assert.doesNotMatch(DECOMPOSE_SYSTEM_PROMPT, /Only use 4/);
  assert.match(DECOMPOSE_SYSTEM_PROMPT, /exactly one element/);
});

test("user message includes context only when given", () => {
  assert.doesNotMatch(buildDecomposeUserMessage("T", "D"), /Context:/);
  assert.match(buildDecomposeUserMessage("T", "D", "C"), /Context:\nC/);
});

test("parses a plain array and keeps the model's count", () => {
  assert.equal(parseSubtasks(JSON.stringify([item(1), item(2)])).length, 2);
  assert.equal(parseSubtasks(JSON.stringify([item(1), item(2), item(3)])).length, 3);
  assert.equal(parseSubtasks(JSON.stringify([item(1)])).length, 1);
});

test("strips markdown fences", () => {
  const raw = "```json\n" + JSON.stringify([item(1), item(2)]) + "\n```";
  assert.equal(parseSubtasks(raw).length, 2);
});

test("keeps long splits, e.g. a 15-item to-do list", () => {
  const raw = JSON.stringify(Array.from({ length: 15 }, (_, i) => item(i + 1)));
  assert.equal(parseSubtasks(raw).length, 15);
});

test("only a runaway reply is clamped, at MAX_SUBTASKS", () => {
  const raw = JSON.stringify(Array.from({ length: MAX_SUBTASKS + 5 }, (_, i) => item(i + 1)));
  const out = parseSubtasks(raw);
  assert.equal(out.length, MAX_SUBTASKS);
  assert.equal(out[0].title, "Task 1");
});

test("drops incomplete or non-object entries", () => {
  const raw = JSON.stringify([item(1), { title: "no description" }, null, "x", item(2)]);
  assert.deepEqual(parseSubtasks(raw).map((s) => s.title), ["Task 1", "Task 2"]);
});

test("rejects non-arrays", () => {
  assert.throws(() => parseSubtasks("{}"), /Expected a JSON array/);
});
