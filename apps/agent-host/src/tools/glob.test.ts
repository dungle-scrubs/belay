import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_GLOB, shapeGlob } from "./glob";

/**
 * The glob tool's output shaping. A broad glob (e.g. `**\/*`) returns at most MAX_GLOB matches; the
 * shaping must say so HONESTLY - the model should know it got a partial, capped slice and narrow the
 * pattern, rather than read the sorted list as the complete set. Mirrors V1's shapeGlobOutput.
 */

test("no matches reads plainly", () => {
  assert.equal(shapeGlob([], false), "(no matches)");
});

test("an un-truncated result leads with the count and sorts the paths", () => {
  assert.equal(shapeGlob(["a.ts"], false), "1 match\na.ts");
  assert.equal(shapeGlob(["b.ts", "a.ts"], false), "2 matches\na.ts\nb.ts");
});

test("a truncated result says the slice is partial and tells the model to narrow", () => {
  const capped = Array.from({ length: MAX_GLOB }, (_, i) => `f${String(i).padStart(4, "0")}.ts`);
  const out = shapeGlob(capped, true);
  assert.match(out, new RegExp(`Showing the first ${MAX_GLOB} matches \\(more exist\\)`));
  assert.match(out, /Narrow the pattern/);
  // The matches are still listed (the model can use them), just flagged as incomplete.
  assert.ok(out.includes("f0000.ts"), "the matched paths are still included");
});
