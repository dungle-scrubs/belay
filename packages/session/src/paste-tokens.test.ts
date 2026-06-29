import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DEFAULT_PASTE_THRESHOLDS,
  isLargePaste,
  parsePasteTokens,
  pasteLineCount,
  pasteTokenFor,
  pasteTokenText,
  stripPasteTokens,
} from "./paste-tokens";

/**
 * 10-large-paste-placeholders M1: the shared `[Pasted text #N +M lines]` token format and the
 * large-paste threshold policy - the contract the web composer produces and the host expands when
 * projecting to the provider. Pinned here so both surfaces parse + threshold identically.
 */

test("pasteTokenText renders the literal token", () => {
  assert.equal(pasteTokenText(24, 3), "[Pasted text #24 +3 lines]");
  assert.equal(pasteTokenText(1, 1), "[Pasted text #1 +1 lines]");
});

test("parsePasteTokens finds tokens with ranges, numbers, and line counts in reading order", () => {
  const spans = parsePasteTokens(
    "see [Pasted text #1 +4 lines] then [Pasted text #2 +9 lines] end",
  );
  assert.deepEqual(
    spans.map((s) => s.num),
    [1, 2],
  );
  assert.deepEqual(
    spans.map((s) => s.lines),
    [4, 9],
  );
  assert.equal(spans[0]?.start, 4);
  assert.equal(spans[0]?.end, "see [Pasted text #1 +4 lines]".length);
});

test("pasteTokenFor derives the line count from the exact payload", () => {
  assert.equal(pasteTokenFor(3, { text: "a\nb\nc" }), "[Pasted text #3 +3 lines]");
  assert.equal(pasteTokenFor(7, { text: "just one line" }), "[Pasted text #7 +1 lines]");
});

test("pasteLineCount: plain, trailing newline, blank lines, CRLF, and Unicode", () => {
  assert.equal(pasteLineCount(""), 0);
  assert.equal(pasteLineCount("solo"), 1);
  assert.equal(pasteLineCount("a\nb\nc"), 3, "three lines, no trailing newline");
  assert.equal(pasteLineCount("a\nb\nc\n"), 3, "a single trailing newline adds no phantom line");
  assert.equal(pasteLineCount("a\n\nb"), 3, "a blank line still counts");
  assert.equal(pasteLineCount("a\r\nb\r\nc"), 3, "CRLF counts as one break each");
  assert.equal(pasteLineCount("a\rb"), 2, "a bare CR is a break");
  assert.equal(pasteLineCount("café\n— dash\n😀"), 3, "Unicode lines count normally");
});

test("stripPasteTokens removes tokens and tidies the whitespace they leave", () => {
  assert.equal(stripPasteTokens("see [Pasted text #1 +4 lines] now"), "see now");
  assert.equal(stripPasteTokens("[Pasted text #1 +4 lines]"), "");
  assert.equal(stripPasteTokens("before [Pasted text #1 +4 lines]"), "before");
  assert.equal(stripPasteTokens("no tokens here"), "no tokens here");
});

test("stripPasteTokens preserves newlines (only collapses spaces/tabs)", () => {
  assert.equal(
    stripPasteTokens("line one [Pasted text #1 +2 lines]\nline two"),
    "line one\nline two",
  );
});

test("isLargePaste: small paste stays literal, boundary tokenizes (lines)", () => {
  const small = Array.from({ length: 19 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(pasteLineCount(small), 19);
  assert.equal(isLargePaste(small), false, "19 lines is below the 20-line threshold");

  const boundary = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(pasteLineCount(boundary), 20);
  assert.equal(isLargePaste(boundary), true, "exactly 20 lines tokenizes");
});

test("isLargePaste: large-by-characters single line crosses the char threshold", () => {
  const justUnder = "x".repeat(DEFAULT_PASTE_THRESHOLDS.chars - 1);
  assert.equal(isLargePaste(justUnder), false, "one char under the threshold stays literal");

  const atBoundary = "x".repeat(DEFAULT_PASTE_THRESHOLDS.chars);
  assert.equal(pasteLineCount(atBoundary), 1, "still a single line");
  assert.equal(isLargePaste(atBoundary), true, "a long single-line blob tokenizes by chars");
});

test("isLargePaste honors custom thresholds", () => {
  assert.equal(isLargePaste("a\nb\nc", { lines: 3, chars: 10_000 }), true);
  assert.equal(isLargePaste("a\nb", { lines: 3, chars: 10_000 }), false);
  assert.equal(isLargePaste("short", { lines: 100, chars: 5 }), true);
});
