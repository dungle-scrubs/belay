import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { test } from "vitest";
import { useVim } from "./use-vim";

/**
 * M6: the React Vim adapter on a real textarea. Proves it is inert when disabled (every key passes
 * through, mode stays insert), that Escape enters/leaves normal, that motions move the caret and
 * consume the key, and that Enter + native chords always pass through so the composer keeps submit/copy.
 */

function Harness({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const vim = useVim(ref, enabled);
  return (
    <textarea
      ref={ref}
      data-testid="ta"
      data-mode={vim.mode}
      defaultValue="hello world"
      onFocus={vim.onFocus}
      // Records on the element whether Vim consumed the key, for assertions.
      onKeyDown={(e) => {
        (e.target as HTMLTextAreaElement).dataset.consumed = String(vim.onKeyDown(e));
      }}
    />
  );
}

function setup(enabled: boolean, caret = 0) {
  const { getByTestId } = render(<Harness enabled={enabled} />);
  const ta = getByTestId("ta") as HTMLTextAreaElement;
  ta.setSelectionRange(caret, caret);
  return ta;
}

test("disabled: every key passes through and the mode stays insert", () => {
  const ta = setup(false, 0);
  for (const key of ["Escape", "l", "j", "x"]) {
    fireEvent.keyDown(ta, { key });
    assert.equal(ta.dataset.consumed, "false", `${key} not consumed when disabled`);
  }
  assert.equal(ta.dataset.mode, "insert");
});

test("enabled: Escape enters normal (consumed), a motion moves the caret, i returns to insert", () => {
  const ta = setup(true, 3);
  fireEvent.keyDown(ta, { key: "Escape" });
  assert.equal(ta.dataset.consumed, "true", "Escape is consumed");
  assert.equal(ta.dataset.mode, "normal");
  assert.equal(ta.selectionStart, 2, "Escape nudges the caret one left (3 -> 2)");

  fireEvent.keyDown(ta, { key: "l" });
  assert.equal(ta.dataset.consumed, "true", "l (motion) is consumed");
  assert.equal(ta.selectionStart, 3, "l moved the caret right (2 -> 3)");

  fireEvent.keyDown(ta, { key: "i" });
  assert.equal(ta.dataset.mode, "insert", "i returns to insert");
});

test("enabled normal: Enter and Cmd-chords pass through; an unsupported key is swallowed", () => {
  const ta = setup(true, 1);
  fireEvent.keyDown(ta, { key: "Escape" }); // -> normal
  fireEvent.keyDown(ta, { key: "Enter" });
  assert.equal(ta.dataset.consumed, "false", "Enter passes through (submit)");
  fireEvent.keyDown(ta, { key: "a", metaKey: true });
  assert.equal(ta.dataset.consumed, "false", "Cmd+a passes through (select-all)");
  fireEvent.keyDown(ta, { key: "z" });
  assert.equal(ta.dataset.consumed, "true", "z is swallowed (never typed in normal)");
});

test("enabled: an IME composition keydown is left to the textarea", () => {
  const ta = setup(true, 0);
  fireEvent.keyDown(ta, { key: "Escape" }); // -> normal
  fireEvent.keyDown(ta, { key: "Process", isComposing: true });
  assert.equal(ta.dataset.consumed, "false", "a composing keydown is not intercepted");
});

test("focus resets the mode to insert", () => {
  const ta = setup(true, 0);
  fireEvent.keyDown(ta, { key: "Escape" });
  assert.equal(ta.dataset.mode, "normal");
  fireEvent.focus(ta);
  assert.equal(ta.dataset.mode, "insert", "re-focusing a Vim prompt starts in insert");
});
