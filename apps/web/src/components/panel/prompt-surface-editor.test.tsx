import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { PromptSurfaceEditor } from "./prompt-surface-editor";

/**
 * The presentational full-surface prompt editor (02.12), under jsdom. It renders the seeded text in a
 * large textarea and confirms (hands the text back) on back / Escape / Cmd-Enter / Done.
 */

function renderEditor(text = "the prompt", title?: string) {
  const onTextChange = vi.fn<(t: string) => void>();
  const onConfirm = vi.fn();
  render(
    <PromptSurfaceEditor
      text={text}
      title={title}
      onTextChange={onTextChange}
      onConfirm={onConfirm}
    />,
  );
  return { onTextChange, onConfirm };
}

test("renders the back button, the title, and a textarea seeded with the text", () => {
  renderEditor("draft body", "Edit handoff prompt");
  assert.ok(screen.getByRole("button", { name: /back/i }));
  assert.ok(screen.getByText("Edit handoff prompt"));
  assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).value, "draft body");
});

test("focuses the textarea on mount with the caret at the end", () => {
  renderEditor("hello world");
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  assert.equal(document.activeElement, ta);
  assert.equal(ta.selectionStart, "hello world".length);
});

test("typing reports the edited text through onTextChange", () => {
  const { onTextChange } = renderEditor("a");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "a b c" } });
  assert.deepEqual(onTextChange.mock.calls.at(-1), ["a b c"]);
});

test("the back button confirms and closes", () => {
  const { onConfirm } = renderEditor();
  fireEvent.click(screen.getByRole("button", { name: /back/i }));
  assert.equal(onConfirm.mock.calls.length, 1);
});

test("Escape confirms (saves and closes)", () => {
  const { onConfirm } = renderEditor();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  assert.equal(onConfirm.mock.calls.length, 1);
});

test("Cmd/Ctrl-Enter confirms", () => {
  const { onConfirm } = renderEditor();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
  assert.equal(onConfirm.mock.calls.length, 1);
});

test("the Done button confirms", () => {
  const { onConfirm } = renderEditor();
  fireEvent.click(screen.getByRole("button", { name: /done/i }));
  assert.equal(onConfirm.mock.calls.length, 1);
});
