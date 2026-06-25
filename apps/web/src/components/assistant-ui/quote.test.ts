import assert from "node:assert/strict";
import { test } from "vitest";
import { buildQuotedComposerText, toBlockquote } from "./quote";

test("toBlockquote prefixes each line; blank lines become a bare '>'", () => {
  assert.equal(toBlockquote("one"), "> one");
  assert.equal(toBlockquote("one\ntwo"), "> one\n> two");
  assert.equal(toBlockquote("a\n\nb"), "> a\n>\n> b");
});

test("quoting into an empty composer yields the blockquote with a trailing blank line", () => {
  const { value, cursor } = buildQuotedComposerText("", "hello world");
  assert.equal(value, "> hello world\n\n");
  // Cursor parks on the fresh line beneath the quote.
  assert.equal(cursor, value.length);
});

test("quoting appends below existing text, separated by a blank line", () => {
  const { value } = buildQuotedComposerText("my note", "quoted");
  assert.equal(value, "my note\n\n> quoted\n\n");
});

test("existing trailing whitespace is collapsed to a single blank-line separator", () => {
  const { value } = buildQuotedComposerText("note\n\n  ", "q");
  assert.equal(value, "note\n\n> q\n\n");
});

test("the selection is trimmed before quoting, and every line of it is prefixed", () => {
  const { value } = buildQuotedComposerText("", "  line1\nline2  ");
  assert.equal(value, "> line1\n> line2\n\n");
});
