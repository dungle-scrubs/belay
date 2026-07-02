import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { PromptSurfaceEditor } from "./prompt-surface-editor";

/**
 * The presentational full-surface prompt editor (02.12), under jsdom. It renders the seeded text in a
 * large textarea and confirms (hands the text back) on back / Escape / Cmd-Enter / Done.
 */

function renderEditor(text = "the prompt", title?: string, vimEnabled = false) {
  const onTextChange = vi.fn<(t: string) => void>();
  const onConfirm = vi.fn();
  render(
    <PromptSurfaceEditor
      text={text}
      title={title}
      onTextChange={onTextChange}
      onConfirm={onConfirm}
      vimEnabled={vimEnabled}
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

test("with Vim disabled there is no mode indicator (the editor is unchanged)", () => {
  renderEditor("x", undefined, false);
  assert.equal(screen.queryByRole("status"), null);
});

test("with Vim enabled the header shows the mode indicator (starts in insert)", () => {
  renderEditor("x", undefined, true);
  assert.ok(screen.getByLabelText("Vim mode: insert"));
});

test("the mode indicator sits immediately right of the title, with no flex-1 spacer (06.1)", () => {
  renderEditor("x", "Edit handoff prompt", true);
  const pill = screen.getByRole("status");
  const prev = pill.previousElementSibling;

  assert.equal(prev?.textContent, "Edit handoff prompt", "the title is the pill's left neighbor");
  assert.ok(!(prev?.className ?? "").includes("flex-1"), "no spacer pushes the pill right");
});

test("Vim Escape enters normal-mode and does NOT close the editor; a second Escape closes", () => {
  const { onConfirm } = renderEditor("hello", undefined, true);
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  ta.setSelectionRange(3, 3);

  fireEvent.keyDown(ta, { key: "Escape" });
  assert.equal(onConfirm.mock.calls.length, 0, "first Escape enters normal, does not close");
  assert.ok(screen.getByLabelText("Vim mode: normal"), "the indicator shows normal");

  fireEvent.keyDown(ta, { key: "Escape" });
  assert.equal(onConfirm.mock.calls.length, 1, "a second Escape (in normal) closes");
});

test("Vim caret shape (06.1): block in normal/visual, thin default in insert", () => {
  renderEditor("hello", undefined, true);
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;

  assert.ok(!ta.className.includes("[caret-shape:block]"), "insert starts with the thin bar");

  fireEvent.keyDown(ta, { key: "Escape" }); // -> normal
  assert.ok(ta.className.includes("[caret-shape:block]"), "normal mode shows the block caret");

  fireEvent.keyDown(ta, { key: "v" }); // -> visual
  assert.ok(screen.getByLabelText("Vim mode: visual"));
  assert.ok(ta.className.includes("[caret-shape:block]"), "visual mode keeps the block caret");

  fireEvent.keyDown(ta, { key: "v" }); // -> normal
  fireEvent.keyDown(ta, { key: "i" }); // -> insert
  assert.ok(!ta.className.includes("[caret-shape:block]"), "insert restores the thin bar");
});

test("with Vim disabled the caret class never appears on the editor textarea", () => {
  renderEditor("hello", undefined, false);
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.keyDown(ta, { key: "Escape" });
  assert.ok(!ta.className.includes("caret-shape"), "no caret-shape class with Vim off");
});

test("Cmd/Ctrl-Enter confirms even in Vim mode, regardless of mode", () => {
  const { onConfirm } = renderEditor("hello", undefined, true);
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.keyDown(ta, { key: "Escape" }); // -> normal
  fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
  assert.equal(onConfirm.mock.calls.length, 1, "Cmd-Enter confirms from normal mode too");
});
