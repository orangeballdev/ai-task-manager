import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isFileBasedOutput,
  isReadOnlyOutput,
  isResultOutput,
  normalizeOutputType,
} from "../output-type";

describe("output types", () => {
  it("normalizes known types and falls back to repository", () => {
    assert.equal(normalizeOutputType("result"), "result");
    assert.equal(normalizeOutputType("file"), "file");
    assert.equal(normalizeOutputType("design"), "design");
    assert.equal(normalizeOutputType("bogus"), "repository");
    assert.equal(normalizeOutputType(undefined), "repository");
  });

  it("treats result as read-only but not file-based", () => {
    assert.equal(isResultOutput("result"), true);
    assert.equal(isFileBasedOutput("result"), false);
    assert.equal(isReadOnlyOutput("result"), true);
    assert.equal(isReadOnlyOutput("file"), true);
    assert.equal(isReadOnlyOutput("design"), true);
    assert.equal(isReadOnlyOutput("repository"), false);
    assert.equal(isReadOnlyOutput(null), false);
  });
});
