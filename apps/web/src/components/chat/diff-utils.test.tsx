import assert from "node:assert/strict";
import { test } from "vitest";
import { generateToolDiff } from "./diff-utils";

/**
 * The single patch-preparation path (D-015): generateToolDiff owns createTwoFilesPatch + withNewline +
 * countChanges and returns the patch together with its +/- counts, so tool-diff and multi-edit-diff
 * never re-derive one from the other and DiffViewer stays display-only.
 */

test("an edit produces a unified patch plus matching added/removed counts", () => {
  const { patch, added, removed } = generateToolDiff(
    "src/a.ts",
    "const x = 1;\nconst y = 2;\n",
    "const x = 1;\nconst y = 3;\n",
    3,
  );
  // The patch carries the file header and the changed lines.
  assert.match(patch, /src\/a\.ts/);
  assert.match(patch, /-const y = 2;/);
  assert.match(patch, /\+const y = 3;/);
  // One line changed: a remove + an add.
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("a freshly written file (empty old) is all additions, no removals", () => {
  const { patch, added, removed } = generateToolDiff("new.txt", "", "line1\nline2\n", 3);
  assert.match(patch, /\+line1/);
  assert.match(patch, /\+line2/);
  assert.equal(added, 2);
  assert.equal(removed, 0);
  // withNewline keeps the empty side empty, so there's no "No newline" noise marker.
  assert.ok(!patch.includes("No newline at end of file"));
});

test("the context argument bounds the unchanged surrounding lines in the patch", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
  const after = ["a", "b", "c", "D", "e", "f", "g"].join("\n");
  const ctx1 = generateToolDiff("f.txt", before, after, 1).patch;
  const ctx3 = generateToolDiff("f.txt", before, after, 3).patch;
  // More context -> more unchanged lines included around the change.
  const countLines = (p: string, ch: string) =>
    p.split("\n").filter((l) => l.startsWith(ch)).length;
  assert.ok(countLines(ctx3, " ") > countLines(ctx1, " "), "ctx=3 includes more surrounding lines");
});
