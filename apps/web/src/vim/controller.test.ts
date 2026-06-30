import assert from "node:assert/strict";
import { test } from "vitest";
import { handleVimKey, type TextSnapshot, type VimKey, type VimState } from "./controller";
import type { VimMode } from "./mode";

/**
 * M4: the prompt Vim state machine - mode transitions and the insert-is-native rule. Pure (no DOM): a
 * focused prompt starts in insert; Escape -> normal; i/a -> insert; v/V -> visual; Escape/v leave
 * visual; and in normal/visual an unsupported printable key is SWALLOWED (never typed).
 */

const snap = (value: string, selStart: number, selEnd = selStart): TextSnapshot => ({
  value,
  selStart,
  selEnd,
});
const k = (key: string, mods: Partial<VimKey> = {}): VimKey => ({ key, ...mods });
const st = (mode: VimMode, extra: Partial<VimState> = {}): VimState => ({ mode, ...extra });

test("insert mode leaves ordinary typing, Enter, arrows, and paste to the textarea (native)", () => {
  const s = snap("hello", 5);
  for (const key of ["a", "Z", "1", " ", "Enter", "Backspace"]) {
    assert.deepEqual(handleVimKey(st("insert"), s, k(key)), {
      handled: false,
      state: { mode: "insert" },
    });
  }
});

test("Escape from insert enters normal and nudges the caret one left (clamped to line start)", () => {
  assert.deepEqual(handleVimKey(st("insert"), snap("hello", 5), k("Escape")), {
    handled: true,
    state: { mode: "normal" },
    selStart: 4,
    selEnd: 4,
  });
  assert.deepEqual(handleVimKey(st("insert"), snap("ab\ncd", 3), k("Escape")), {
    handled: true,
    state: { mode: "normal" },
    selStart: 3,
    selEnd: 3,
  });
});

test("normal i/a enter insert at / after the caret", () => {
  assert.deepEqual(handleVimKey(st("normal"), snap("hello", 2), k("i")), {
    handled: true,
    state: { mode: "insert" },
    selStart: 2,
    selEnd: 2,
  });
  assert.deepEqual(handleVimKey(st("normal"), snap("hello", 2), k("a")), {
    handled: true,
    state: { mode: "insert" },
    selStart: 3,
    selEnd: 3,
  });
});

test("normal v enters charwise visual (one char), V enters linewise visual (the whole line)", () => {
  assert.deepEqual(handleVimKey(st("normal"), snap("hello", 1), k("v")), {
    handled: true,
    state: { mode: "visual", anchor: 1 },
    selStart: 1,
    selEnd: 2,
  });
  assert.deepEqual(handleVimKey(st("normal"), snap("ab\ncd\nef", 4), k("V", { shift: true })), {
    handled: true,
    state: { mode: "visual", anchor: 3 },
    selStart: 3,
    selEnd: 5,
  });
});

test("Escape and v collapse visual back to normal at the selection head", () => {
  for (const key of [k("Escape"), k("v")]) {
    assert.deepEqual(handleVimKey(st("visual", { anchor: 1 }), snap("hello", 1, 4), key), {
      handled: true,
      state: { mode: "normal" },
      selStart: 1,
      selEnd: 1,
    });
  }
});

test("a second Escape in normal mode passes through (so it can cancel a turn / clear the draft)", () => {
  assert.deepEqual(handleVimKey(st("normal"), snap("hello", 2), k("Escape")), {
    handled: false,
    state: { mode: "normal" },
  });
});

test("Enter and OS/clipboard chords pass through in normal + visual (composer keeps submit/copy/paste)", () => {
  for (const mode of ["normal", "visual"] as VimMode[]) {
    const state = st(mode, mode === "visual" ? { anchor: 0 } : {});
    const s = snap("hello", 1, mode === "visual" ? 3 : 1);
    // Enter -> submit; Cmd+a select-all; Cmd+c copy; Cmd+v paste; Cmd+Enter confirm.
    for (const key of [
      k("Enter"),
      k("a", { meta: true }),
      k("c", { meta: true }),
      k("v", { meta: true }),
    ]) {
      const r = handleVimKey(state, s, key);
      assert.equal(r.handled, false, `${mode}: ${key.key}${key.meta ? "+meta" : ""} stays native`);
    }
    // Ctrl-V is the exception: it enters visual-block (handled) rather than passing through.
    assert.equal(handleVimKey(st("normal"), s, k("v", { ctrl: true })).handled, true);
  }
});

test("an unsupported printable key in normal/visual is swallowed, never typed", () => {
  for (const mode of ["normal", "visual"] as VimMode[]) {
    const result = handleVimKey(
      st(mode, mode === "visual" ? { anchor: 2 } : {}),
      snap("hi", 2, 2),
      k("z"),
    );
    assert.equal(result.handled, true, `${mode}: z is consumed`);
    if (result.handled) {
      assert.equal(result.value, undefined, `${mode}: z does not change the text`);
      assert.equal(result.state.mode, mode);
    }
  }
});
