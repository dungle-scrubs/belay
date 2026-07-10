import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { test } from "vitest";
import { MultiEditDiff } from "./multi-edit-diff";
import { ToolDiff } from "./tool-diff";

/**
 * Plan 58.6.1 M3: render smoke tests for the transcript's diff surfaces (`ToolDiff` for write/edit,
 * `MultiEditDiff` for multi_edit). Both mount the vendored assistant-ui `DiffViewer` through the lazy
 * chunk, so this exercises the full tool-row -> Suspense -> viewer path and locks the STRUCTURAL
 * output (tool row header, per-file stats, add/del diff lines). These are the tests that must survive
 * a future assistant-ui version bump - if a bump breaks the diff render, they fail at review time.
 */

test("58.6.1 M3: ToolDiff renders the tool row and its structured diff (add + del lines)", async () => {
  render(
    <ToolDiff tool="edit" path="src/a.ts" oldText={"const x = 1;\n"} newText={"const x = 2;\n"} />,
  );

  // The tool row header renders synchronously (name + path).
  assert.ok(screen.getByText("edit", { exact: false }), "the tool row names the tool");

  // The diff body resolves through the lazy DiffViewer chunk.
  const viewer = await screen.findByText("const x = 2;", { exact: false });
  const root = viewer.closest('[data-slot="diff-viewer"]');
  assert.ok(root, "the diff renders inside the vendored DiffViewer");
  assert.ok(
    root?.querySelector('[data-slot="diff-viewer-line"][data-type="add"]'),
    "the added line is typed data-type=add",
  );
  assert.ok(
    root?.querySelector('[data-slot="diff-viewer-line"][data-type="del"]'),
    "the removed line is typed data-type=del",
  );
});

test("58.6.1 M3: MultiEditDiff renders one atomic op grouped by file with per-file diffs", async () => {
  render(
    <MultiEditDiff
      edits={[
        { path: "src/a.ts", old: "const a = 1;\n", new: "const a = 2;\n" },
        { path: "src/b.ts", old: "const b = 1;\n", new: "const b = 2;\n" },
      ]}
    />,
  );

  // The summary line reflects the operation shape (edits · files · +/-).
  assert.ok(
    screen.getByText(/2 edits · 2 files/, { exact: false }),
    "the multi_edit summary names the edit + file counts",
  );

  // Each file's diff resolves through the lazy DiffViewer chunk.
  const first = await screen.findByText("const a = 2;", { exact: false });
  const second = await screen.findByText("const b = 2;", { exact: false });
  assert.ok(
    first.closest('[data-slot="diff-viewer"]'),
    "the first file diff renders in a DiffViewer",
  );
  assert.ok(
    second.closest('[data-slot="diff-viewer"]'),
    "the second file diff renders in a DiffViewer",
  );
});
