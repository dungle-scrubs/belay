import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import type { ToolDetailModel } from "./detail-model";
import { ToolDetailView } from "./tool-detail-view";

/**
 * M2: the detail takeover shell. It renders the tool name, status, arguments, and output; the top-left
 * "Back to chat" arrow AND Escape both return to chat (Escape is owned locally because the view is a
 * frontmost surface, so the global Escape is suppressed behind it).
 */

function model(over: Partial<ToolDetailModel> = {}): ToolDetailModel {
  return {
    id: "c1",
    source: "tool",
    toolName: "bash",
    status: "done",
    aborted: false,
    args: '{"command":"ls"}',
    output: "a.ts\nb.ts",
    ...over,
  };
}

test("renders the header (tool name + status) and dispatches the per-tool body", () => {
  render(<ToolDetailView model={model()} onBack={vi.fn()} />);
  assert.ok(screen.getByText("bash"), "the tool name is in the header");
  assert.ok(screen.getByText("Done"), "the status pill is in the header");
  assert.ok(screen.getByText("ls"), "the bash body renders the command");
  assert.ok(
    screen.getByText(/a\.ts\s+b\.ts/),
    "the multi-line output renders in the Output section",
  );
});

test("the back arrow returns to chat", () => {
  const onBack = vi.fn();
  render(<ToolDetailView model={model()} onBack={onBack} />);
  fireEvent.click(screen.getByLabelText("Back to chat"));
  assert.equal(onBack.mock.calls.length, 1);
});

test("Escape returns to chat", () => {
  const onBack = vi.fn();
  render(<ToolDetailView model={model()} onBack={onBack} />);
  fireEvent.keyDown(screen.getByLabelText("Tool detail: bash"), { key: "Escape" });
  assert.equal(onBack.mock.calls.length, 1);
});

test("a running tool shows the no-output-yet state", () => {
  render(
    <ToolDetailView model={model({ status: "running", output: undefined })} onBack={vi.fn()} />,
  );
  assert.ok(screen.getByText("Running - no output yet."));
});

test("an error tool shows the Error section + an Aborted pill when aborted", () => {
  render(
    <ToolDetailView
      model={model({ status: "error", aborted: true, error: "aborted before completion" })}
      onBack={vi.fn()}
    />,
  );
  assert.ok(screen.getByText("Aborted"));
  assert.ok(screen.getByText("aborted before completion"));
});
