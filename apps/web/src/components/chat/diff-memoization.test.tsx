import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { beforeEach, test, vi } from "vitest";
import { MultiEditDiff } from "./multi-edit-diff";
import { ToolDiff } from "./tool-diff";

// Diff-prep probe (Tier 3.2): wrap the real generateToolDiff with a call counter. ToolDiff and
// MultiEditDiff cache the prepared patch + counts on the edit content, so a parent re-render with
// identity-stable props (the transcript projector keeps untouched rows stable) must not re-diff.
const { diffedPaths } = vi.hoisted(() => ({ diffedPaths: [] as string[] }));
vi.mock("./diff-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diff-utils")>();
  return {
    ...actual,
    generateToolDiff: (...args: Parameters<typeof actual.generateToolDiff>) => {
      diffedPaths.push(args[0]);
      return actual.generateToolDiff(...args);
    },
  };
});

beforeEach(() => {
  diffedPaths.length = 0;
});

test("ToolDiff diffs once and skips re-diffing when content props are unchanged", () => {
  const props = { tool: "edit", path: "src/a.ts", oldText: "const x = 1;\n" };
  const { rerender } = render(<ToolDiff {...props} newText={"const x = 2;\n"} />);
  assert.deepEqual(diffedPaths, ["src/a.ts"]);

  // A parent re-render with the same content (fresh element, same primitive props) re-diffs nothing.
  rerender(<ToolDiff {...props} newText={"const x = 2;\n"} />);
  assert.deepEqual(diffedPaths, ["src/a.ts"]);

  // Changed content recomputes.
  rerender(<ToolDiff {...props} newText={"const x = 3;\n"} />);
  assert.deepEqual(diffedPaths, ["src/a.ts", "src/a.ts"]);
});

test("MultiEditDiff diffs each edit exactly once and reuses it while `edits` identity holds", () => {
  const edits = [
    { path: "src/a.ts", old: "one\n", new: "uno\n" },
    { path: "src/a.ts", old: "two\n", new: "dos\n" },
    { path: "src/b.ts", old: "three\n", new: "tres\n" },
  ];
  const { rerender, container } = render(<MultiEditDiff edits={edits} />);
  // One diff per edit - the summary's totals come from the same prepared diffs, not a second pass.
  assert.deepEqual(diffedPaths, ["src/a.ts", "src/a.ts", "src/b.ts"]);
  // Each edit swaps one line, so 3 edits sum to +3 -3 across 2 files.
  assert.ok(container.textContent?.includes("3 edits · 2 files · +3 -3"));

  // A parent re-render with the projector-stable array identity re-diffs nothing.
  rerender(<MultiEditDiff edits={edits} />);
  assert.deepEqual(diffedPaths, ["src/a.ts", "src/a.ts", "src/b.ts"]);

  // A genuinely new edits array (a mutated row got fresh identity) recomputes.
  rerender(<MultiEditDiff edits={[...edits, { path: "src/b.ts", old: "x\n", new: "y\n" }]} />);
  assert.equal(diffedPaths.length, 7);
});
