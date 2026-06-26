import assert from "node:assert/strict";
import { test } from "vitest";
import { caretOnFirstLine, caretOnLastLine } from "./composer-caret";

/**
 * The composer's prompt-history eligibility predicates (D-084): ArrowUp recalls only from the first
 * line, ArrowDown advances only from the last line, so multi-line editing keeps normal caret movement.
 */

test("caretOnFirstLine is true until a newline precedes the caret", () => {
  // Single line: always the first line.
  assert.equal(caretOnFirstLine("hello", 0), true);
  assert.equal(caretOnFirstLine("hello", 5), true);
  // Multi-line: first line until the caret moves past the first newline.
  assert.equal(caretOnFirstLine("a\nb", 0), true);
  assert.equal(caretOnFirstLine("a\nb", 1), true); // before the newline
  assert.equal(caretOnFirstLine("a\nb", 2), false); // after the newline (on "b")
  assert.equal(caretOnFirstLine("a\nb", 3), false);
});

test("caretOnLastLine is true once no newline remains at or after the caret", () => {
  assert.equal(caretOnLastLine("hello", 0), true);
  assert.equal(caretOnLastLine("hello", 5), true);
  assert.equal(caretOnLastLine("a\nb", 0), false); // a newline follows
  assert.equal(caretOnLastLine("a\nb", 1), false);
  assert.equal(caretOnLastLine("a\nb", 2), true); // on the last line ("b")
  assert.equal(caretOnLastLine("a\nb", 3), true);
});
