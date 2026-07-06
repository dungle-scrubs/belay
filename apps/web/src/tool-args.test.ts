import assert from "node:assert/strict";
import { test } from "vitest";
import { toolActionLabel } from "./action-label";
import { multiEditPaths, salientToolArg, toolSummary } from "./tool-args";

/**
 * Plan 08.1: multi_edit has no top-level `path` - each edit carries its own `edits[].path`. The
 * salient registry derives the file(s) from `edits[]` once, so the live action label, the compact
 * row, and the detail FILE chip all name the file a multi_edit touches instead of falling back to a
 * pathless verb.
 */

const single = '{"edits":[{"path":"a.ts","old":"x","new":"y"}]}';
const multiFile =
  '{"edits":[{"path":"a.ts","old":"x","new":"y"},{"path":"b.ts","old":"a","new":"b"}]}';

test("multiEditPaths returns distinct paths in first-seen order", () => {
  assert.deepEqual(
    multiEditPaths([
      { path: "a.ts", old: "x", new: "y" },
      { path: "b.ts", old: "a", new: "b" },
      { path: "a.ts", old: "c", new: "d" },
      { path: "c.ts", old: "e", new: "f" },
    ]),
    ["a.ts", "b.ts", "c.ts"],
  );
});

test("multiEditPaths tolerates a partial / malformed edits array without throwing", () => {
  assert.deepEqual(multiEditPaths(undefined), [], "non-array yields no paths");
  assert.deepEqual(multiEditPaths("nope"), [], "a non-array value yields no paths");
  assert.deepEqual(
    multiEditPaths([{ old: "x", new: "y" }, null, { path: "", old: "a", new: "b" }]),
    [],
    "edits missing / empty a path are skipped (streaming tolerance)",
  );
  assert.deepEqual(
    multiEditPaths([{ path: "a.ts", old: "x", new: "y" }, { old: "no path yet" }]),
    ["a.ts"],
    "a path-less edit mid-stream doesn't drop the paths already streamed",
  );
});

test("salientToolArg resolves multi_edit's path from edits[] (not a top-level path)", () => {
  assert.equal(salientToolArg("multi_edit", JSON.parse(single)), "a.ts");
  // The multi-file case leads with the first distinct path (D-005 single-string surface).
  assert.ok(
    String(salientToolArg("multi_edit", JSON.parse(multiFile))).startsWith("a.ts"),
    "multi-file salient value leads with the first distinct path",
  );
  // A still-streaming multi_edit with no path yet collapses to empty, never a raw-args leak.
  assert.equal(salientToolArg("multi_edit", { edits: [{ old: "x", new: "y" }] }), undefined);
  assert.equal(salientToolArg("multi_edit", {}), undefined);
});

test("toolActionLabel names the file a single-file multi_edit is editing", () => {
  assert.equal(toolActionLabel("multi_edit", single), "editing a.ts");
});

test("toolActionLabel adds a bounded N-files indicator for a multi-file multi_edit", () => {
  const label = toolActionLabel("multi_edit", multiFile);
  assert.ok(label.startsWith("editing a.ts"), "leads with the verb + first file");
  assert.match(label, /2 files/, "carries the bounded multi-file indicator (D-005)");
});

test("the multi-file indicator stays within the redacted label bound for a long path", () => {
  const longPath = `apps/web/src/${"a".repeat(80)}.ts`;
  const args = JSON.stringify({
    edits: [
      { path: longPath, old: "x", new: "y" },
      { path: "b.ts", old: "a", new: "b" },
    ],
  });
  // toolSummary caps at 60, then redactLabelFragment caps the target at 48 - the label never blows
  // the bound even when the first path alone overflows it (Risk Register: label bound).
  assert.ok(toolSummary("multi_edit", args).length <= 60);
  assert.ok(
    toolActionLabel("multi_edit", args).length <= "editing ".length + 48,
    "the composed action label respects the 48-char target bound",
  );
});
