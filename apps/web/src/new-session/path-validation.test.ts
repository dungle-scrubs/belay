import assert from "node:assert/strict";
import { test } from "vitest";
import { validatePath } from "./path-validation";

/**
 * Plan 44.2 M3: client-side path validation. Empty/whitespace is `"empty"`, an absolute or home-relative
 * path is `"valid"`, and anything else non-empty is `"invalid"` (Create is enabled only for `"valid"`).
 */

test("empty or whitespace is empty", () => {
  assert.equal(validatePath(""), "empty");
  assert.equal(validatePath("   "), "empty");
});

test("absolute and home-relative paths are valid", () => {
  assert.equal(validatePath("/Users/kevin/dev/foo"), "valid");
  assert.equal(validatePath("~"), "valid");
  assert.equal(validatePath("~/dev/foo"), "valid");
  assert.equal(validatePath("  ~/dev/foo  "), "valid", "surrounding whitespace is trimmed");
});

test("a bare name or relative path is invalid", () => {
  assert.equal(validatePath("foo"), "invalid");
  assert.equal(validatePath("./foo"), "invalid");
  assert.equal(validatePath("../foo"), "invalid");
  assert.equal(validatePath("dev/foo"), "invalid");
});
