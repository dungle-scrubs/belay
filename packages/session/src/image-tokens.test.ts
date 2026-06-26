import assert from "node:assert/strict";
import { test } from "vitest";
import { imageTokenText, parseImageTokens, stripImageTokens } from "./image-tokens";

/**
 * D-092: the shared `[Image #N]` token format - the contract the web composer produces and the host
 * strips when projecting to the provider. Pinned here so both surfaces parse + strip identically.
 */

test("imageTokenText renders the literal token", () => {
  assert.equal(imageTokenText(3), "[Image #3]");
});

test("parseImageTokens finds tokens with ranges and numbers in reading order", () => {
  const spans = parseImageTokens("a [Image #1] b [Image #2]");
  assert.deepEqual(
    spans.map((s) => s.num),
    [1, 2],
  );
  assert.equal(spans[0]?.start, 2);
  assert.equal(spans[0]?.end, "a [Image #1]".length);
});

test("stripImageTokens removes tokens and tidies the whitespace they leave", () => {
  assert.equal(stripImageTokens("look at [Image #1] and [Image #2]"), "look at and");
  assert.equal(stripImageTokens("[Image #1]"), "");
  assert.equal(stripImageTokens("before [Image #1]"), "before");
  assert.equal(stripImageTokens("no tokens here"), "no tokens here");
});

test("stripImageTokens preserves newlines (only collapses spaces/tabs)", () => {
  assert.equal(stripImageTokens("line one [Image #1]\nline two"), "line one\nline two");
});
