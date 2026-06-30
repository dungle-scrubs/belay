import assert from "node:assert/strict";
import { test } from "vitest";
import { handleVimKey, type TextSnapshot, type VimKey } from "./controller";
import type { VimMode } from "./mode";

/**
 * M4: the prompt Vim state machine - mode transitions and the insert-is-native rule. Pure (no DOM): a
 * focused prompt starts in insert; Escape -> normal; i/a -> insert; v/V -> visual; Escape/v leave
 * visual; and in normal/visual an unsupported printable key is SWALLOWED (never typed into the textarea).
 */

const snap = (value: string, selStart: number, selEnd = selStart): TextSnapshot => ({
  value,
  selStart,
  selEnd,
});
const k = (key: string, mods: Partial<VimKey> = {}): VimKey => ({ key, ...mods });

test("insert mode leaves ordinary typing, Enter, arrows, and paste to the textarea (native)", () => {
  const s = snap("hello", 5);
  for (const key of ["a", "Z", "1", " ", "Enter", "ArrowUp", "Backspace"]) {
    assert.deepEqual(handleVimKey("insert", s, k(key)), { handled: false, mode: "insert" });
  }
});

test("Escape from insert enters normal and nudges the caret one left (clamped to line start)", () => {
  assert.deepEqual(handleVimKey("insert", snap("hello", 5), k("Escape")), {
    handled: true,
    mode: "normal",
    selStart: 4,
    selEnd: 4,
  });
  // At the line start it stays put (no underflow onto the previous line).
  assert.deepEqual(handleVimKey("insert", snap("ab\ncd", 3), k("Escape")), {
    handled: true,
    mode: "normal",
    selStart: 3,
    selEnd: 3,
  });
});

test("normal i/a enter insert at / after the caret", () => {
  assert.deepEqual(handleVimKey("normal", snap("hello", 2), k("i")), {
    handled: true,
    mode: "insert",
    selStart: 2,
    selEnd: 2,
  });
  assert.deepEqual(handleVimKey("normal", snap("hello", 2), k("a")), {
    handled: true,
    mode: "insert",
    selStart: 3,
    selEnd: 3,
  });
});

test("normal v enters charwise visual (one char), V enters linewise visual (the whole line)", () => {
  assert.deepEqual(handleVimKey("normal", snap("hello", 1), k("v")), {
    handled: true,
    mode: "visual",
    selStart: 1,
    selEnd: 2,
  });
  assert.deepEqual(handleVimKey("normal", snap("ab\ncd\nef", 4), k("V", { shift: true })), {
    handled: true,
    mode: "visual",
    selStart: 3,
    selEnd: 5,
  });
});

test("Escape and v collapse visual back to normal at the selection head", () => {
  for (const key of [k("Escape"), k("v")]) {
    assert.deepEqual(handleVimKey("visual", snap("hello", 1, 4), key), {
      handled: true,
      mode: "normal",
      selStart: 1,
      selEnd: 1,
    });
  }
});

test("Escape in normal stays normal and is consumed (does not bubble to cancel/menus)", () => {
  assert.deepEqual(handleVimKey("normal", snap("hello", 2), k("Escape")), {
    handled: true,
    mode: "normal",
    selStart: 2,
    selEnd: 2,
  });
});

test("an unsupported printable key in normal/visual is swallowed, never typed", () => {
  for (const mode of ["normal", "visual"] as VimMode[]) {
    const result = handleVimKey(mode, snap("hello", 2, mode === "visual" ? 3 : 2), k("z"));
    assert.equal(result.handled, true, `${mode}: z is consumed`);
    if (result.handled) {
      assert.equal(result.value, undefined, `${mode}: z does not change the text`);
      assert.equal(result.mode, mode);
    }
  }
});
