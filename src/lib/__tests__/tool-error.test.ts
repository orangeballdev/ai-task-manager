import { test } from "node:test";
import assert from "node:assert/strict";
import { describeToolError } from "../tool-error";

test("Bash exit code becomes the message, output is dropped", () => {
  const d = describeToolError("Exit code 2\nnpm ERR! secret=hunter2");
  assert.deepEqual(d, { message: "Exit code 2", exitCode: 2 });
});

test("content blocks are read too", () => {
  assert.equal(describeToolError([{ type: "text", text: "Exit code 127\nnot found" }]).exitCode, 127);
});

test("CLI tool_use_error keeps only its first line", () => {
  const d = describeToolError("<tool_use_error>String to replace not found in file.\nString: API_KEY=abc</tool_use_error>");
  assert.equal(d.message, "String to replace not found in file.");
});

test("timeouts, permissions and interrupts are named", () => {
  assert.equal(describeToolError("Command timed out after 2m 0.0s").message, "Command timed out");
  assert.equal(describeToolError("Claude requested permissions to use Bash, but you haven't granted it yet.").message, "Permission denied");
  assert.equal(describeToolError("[Request interrupted by user for tool use]").message, "Interrupted");
});

test("in-process tool errors never leak the command or path", () => {
  assert.equal(describeToolError("Error: Command failed: curl -H 'Authorization: x'").message, "Command failed");
  assert.equal(describeToolError("Error reading file: ENOENT: no such file, open '/secret/path'").message, "ENOENT");
});

test("anything unrecognised gets the generic message", () => {
  assert.match(describeToolError("some arbitrary tool output with a token").message, /output not recorded/);
  assert.match(describeToolError(undefined).message, /output not recorded/);
});
