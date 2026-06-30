import assert from "node:assert/strict";
import { test } from "vitest";
import { handleVimKey, INITIAL_VIM_STATE, type VimKey, type VimState } from "./controller";

/**
 * M5: normal-mode motions (h/j/k/l, w, b, 0, $, gg, G), conservative editing (x; visual d/x), and
 * visual selection extension. Driven through a tiny mock textarea that applies each handled result, so
 * multi-key sequences (gg, v + motions) thread the controller state exactly as the React wrapper will.
 */

interface Editor {
  value: string;
  selStart: number;
  selEnd: number;
  state: VimState;
}

/** Runs a sequence of keys through the controller, applying each handled result (M6's wrapper, in pure
 *  form). A key is `"x"` or `"Shift+V"` / `"Ctrl+v"` style. Returns the final editor. */
function drive(
  value: string,
  caret: number,
  keys: readonly string[],
  mode: VimState["mode"] = "normal",
): Editor {
  const ed: Editor = { value, selStart: caret, selEnd: caret, state: { mode } };
  for (const spec of keys) {
    const key = parseKey(spec);
    const result = handleVimKey(ed.state, ed, key);
    ed.state = result.state;
    if (result.handled) {
      if (result.value !== undefined) {
        ed.value = result.value;
      }
      ed.selStart = result.selStart;
      ed.selEnd = result.selEnd;
    }
  }
  return ed;
}

function parseKey(spec: string): VimKey {
  const parts = spec.split("+");
  const key = parts.pop() as string;
  return {
    key,
    ctrl: parts.includes("Ctrl"),
    meta: parts.includes("Meta"),
    shift: parts.includes("Shift"),
  };
}

const caretAfter = (value: string, caret: number, keys: readonly string[]) =>
  drive(value, caret, keys).selStart;

test("h/l move one char, clamped within the line", () => {
  assert.equal(caretAfter("hello", 2, ["h"]), 1);
  assert.equal(caretAfter("hello", 2, ["l"]), 3);
  assert.equal(caretAfter("hello", 0, ["h"]), 0, "h clamps at line start");
  assert.equal(caretAfter("ab\ncd", 0, ["h"]), 0);
  assert.equal(caretAfter("ab\ncd", 2, ["l"]), 2, "l clamps at line end (the newline)");
});

test("0 and $ jump to line start / end", () => {
  assert.equal(caretAfter("  hello", 4, ["0"]), 0);
  assert.equal(caretAfter("hello\nworld", 7, ["$"]), 11);
  assert.equal(caretAfter("ab\ncd", 0, ["$"]), 2, "$ stops at the newline, not the doc end");
});

test("j/k move vertically, keeping the column clamped to the target line", () => {
  // "hello\nhi" : caret at col 4 on line 0 -> line 1 has only 2 chars, clamp to its end.
  assert.equal(
    caretAfter("hello\nhi", 4, ["j"]),
    8,
    "j clamps the column to the shorter next line",
  );
  assert.equal(
    caretAfter("hi\nhello", 7, ["k"]),
    2,
    "k clamps the column to the shorter prev line",
  );
  assert.equal(caretAfter("hello", 2, ["j"]), 2, "no line below -> stay");
  assert.equal(caretAfter("hello", 2, ["k"]), 2, "no line above -> stay");
});

test("w/b move by word, respecting word vs punctuation boundaries", () => {
  assert.equal(caretAfter("hello world", 0, ["w"]), 6, "w -> next word start");
  assert.equal(caretAfter("foo.bar baz", 0, ["w"]), 3, "w stops at the punctuation run");
  assert.equal(caretAfter("foo.bar baz", 3, ["w"]), 4, "w over the dot to 'bar'");
  assert.equal(caretAfter("hello world", 6, ["b"]), 0, "b -> previous word start");
  assert.equal(caretAfter("hello world", 8, ["b"]), 6, "b -> start of the current word");
});

test("gg jumps to the document start, G to the end", () => {
  assert.equal(caretAfter("a\nb\nc", 4, ["g", "g"]), 0);
  assert.equal(caretAfter("a\nb\nc", 0, ["G"]), 5);
  // `gl` is not a command: the pending `g` consumes the `l` and nothing moves (vim-style discard).
  assert.equal(caretAfter("a\nb\nc", 2, ["g", "l"]), 2, "g then a non-g is a discarded no-op");
});

test("x deletes the char under the caret, never across a newline or past the end", () => {
  const a = drive("hello", 1, ["x"]);
  assert.equal(a.value, "hllo");
  assert.equal(a.selStart, 1);
  // At a newline / end of value, x is a no-op (no merge of lines, no underflow).
  assert.equal(drive("ab\ncd", 2, ["x"]).value, "ab\ncd", "x at the newline does nothing");
  assert.equal(drive("ab", 2, ["x"]).value, "ab", "x past the end does nothing");
});

test("visual mode extends the selection with motions, then d deletes it", () => {
  // v selects 1 char, then l l grows it to 3 chars [1,4).
  const sel = drive("hello", 1, ["v", "l", "l"]);
  assert.equal(sel.state.mode, "visual");
  assert.deepEqual([sel.selStart, sel.selEnd], [1, 4]);

  const del = drive("hello world", 0, ["v", "w", "d"]);
  assert.equal(del.state.mode, "normal", "d returns to normal");
  assert.equal(del.value, "world", "the visual selection (hello + space) is deleted");
});

test("visual selection can extend backward past the anchor (the anchor stays fixed)", () => {
  // caret at 3, v anchors the left edge at 3 ([3,4]); h then h walks the moving end left to 2 -> [2,3].
  const sel = drive("hello", 3, ["v", "h", "h"]);
  assert.deepEqual([sel.selStart, sel.selEnd], [2, 3]);
  assert.equal(sel.state.anchor, 3, "the anchor stays where visual began");
});

test("the initial state is insert (a freshly focused prompt types normally)", () => {
  assert.equal(INITIAL_VIM_STATE.mode, "insert");
});
