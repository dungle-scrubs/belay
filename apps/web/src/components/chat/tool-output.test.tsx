import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { ToolOutput } from "./tool-output";

/**
 * The text-output tool renderer in a DOM: long output collapses to a few preview lines with a
 * "+N more lines" indicator (so a big listing doesn't flood the transcript), and a body-less
 * call renders a bare row. Proves the web DOM lane works against a real component. S-WEB-3.
 */

test("collapses output past the preview limit, with a '+N more lines' indicator", () => {
  const output = ["line1", "line2", "line3", "line4", "line5"].join("\n");
  const { container } = render(<ToolOutput name="bash" output={output} previewLines={3} />);
  const text = container.textContent ?? "";

  assert.ok(text.includes("line1") && text.includes("line3"), "preview lines must show");
  assert.ok(!text.includes("line4"), "lines past the preview limit must be hidden");
  assert.ok(text.includes("+2 more lines"), text);
});

test("shows every line when the output fits within the preview limit", () => {
  const { container } = render(<ToolOutput name="bash" output={"only\ntwo"} previewLines={3} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("only") && text.includes("two"));
  assert.ok(!text.includes("more lines"), "no overflow indicator when nothing is hidden");
});

test("a body-less tool call renders a bare row with the tool name", () => {
  const { container } = render(<ToolOutput name="bash" />);
  assert.ok((container.textContent ?? "").includes("bash"));
});
