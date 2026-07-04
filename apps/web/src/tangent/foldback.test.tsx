import assert from "node:assert/strict";
import { test } from "vitest";
import { foldBackPreview } from "./foldback";

/**
 * M8 fold-back preview (pure): the durable `tangent.foldedBack` marker carries only a bounded, single-line
 * snippet for observability - never the full tangent text. Runs in the `web` project.
 */

test("foldBackPreview is a bounded single-line snippet for the durable marker", () => {
  assert.equal(foldBackPreview("  multi\n  line\n  text  "), "multi line text");
  const long = "x".repeat(300);
  const preview = foldBackPreview(long);
  assert.ok(preview.length <= 201);
  assert.ok(preview.endsWith("…"));
});
