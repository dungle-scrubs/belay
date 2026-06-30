import type { VimMode } from "./mode";

/**
 * The prompt-local Vim controller (plan 06, M4/M5): a small, framework-agnostic state machine over a
 * textarea snapshot, chosen over `vimeejs/vimee` (decision D-008) so it yields cleanly to native typing
 * and the composer's existing key precedence. It is pure - it takes the current mode + a `{ value,
 * selStart, selEnd }` snapshot + a key, and returns either "not handled" (let the textarea / App handle
 * it natively: insert typing, Enter-submit, the slash menu, history recall, IME) or "handled" with the
 * next mode + selection (+ optional value) for the caller to apply and `preventDefault`. No DOM, no
 * React - so it is unit-tested without jsdom (M4 REFACTOR).
 *
 * Mode model: a focused prompt starts in `insert` (native typing); Escape enters `normal`; `v`/`V`/
 * Ctrl-V enter `visual` from `normal`; Escape leaves `visual`/`normal` back to `normal`. In `normal`
 * and `visual` the controller SWALLOWS every otherwise-unhandled printable key, so pressing `j` never
 * types a "j" - the defining Vim behavior. Motions + edits (M5) fill in the specific keys.
 */

export interface TextSnapshot {
  readonly value: string;
  readonly selStart: number;
  readonly selEnd: number;
}

export interface VimKey {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

/**
 * The controller's verdict for a key. `handled: false` -> the caller does nothing (native textarea /
 * App handling proceeds); the mode is unchanged. `handled: true` -> the caller applies `selStart`/
 * `selEnd` (and `value` if present) to the textarea, sets `mode`, and calls `preventDefault`.
 */
export type VimResult =
  | { readonly handled: false; readonly mode: VimMode }
  | {
      readonly handled: true;
      readonly mode: VimMode;
      readonly selStart: number;
      readonly selEnd: number;
      readonly value?: string;
    };

/** A modifier-free single character key (e.g. `i`, `j`), not a chord or named key. */
function isPlain(key: VimKey, char: string): boolean {
  return key.key === char && !key.ctrl && !key.meta && !key.alt;
}

function isEscape(key: VimKey): boolean {
  return key.key === "Escape";
}

/** The index of the first character of the line containing `pos`. */
export function lineStart(value: string, pos: number): number {
  const nl = value.lastIndexOf("\n", Math.max(0, pos - 1));
  return nl === -1 ? 0 : nl + 1;
}

/** The index just past the last character of the line containing `pos` (the position of the newline,
 *  or the end of the value). */
export function lineEnd(value: string, pos: number): number {
  const nl = value.indexOf("\n", pos);
  return nl === -1 ? value.length : nl;
}

/** A collapsed caret at `pos`, handled. */
function caret(mode: VimMode, pos: number): VimResult {
  return { handled: true, mode, selStart: pos, selEnd: pos };
}

/** Swallow a key with no effect (normal/visual mode never types text), keeping the current selection. */
function swallow(mode: VimMode, snap: TextSnapshot): VimResult {
  return { handled: true, mode, selStart: snap.selStart, selEnd: snap.selEnd };
}

/** Dispatches a key against the current mode. The entry point both surfaces (composer + editor) call. */
export function handleVimKey(mode: VimMode, snap: TextSnapshot, key: VimKey): VimResult {
  if (mode === "insert") {
    return insertKey(snap, key);
  }
  if (mode === "normal") {
    return normalKey(snap, key);
  }
  return visualKey(snap, key);
}

/** Insert mode is native typing, EXCEPT Escape -> normal (with the vim cursor-left-on-exit nudge). */
function insertKey(snap: TextSnapshot, key: VimKey): VimResult {
  if (isEscape(key)) {
    // Vim nudges the caret one left when leaving insert, clamped to the line start.
    const pos = Math.max(lineStart(snap.value, snap.selStart), snap.selStart - 1);
    return caret("normal", pos);
  }
  return { handled: false, mode: "insert" };
}

/** Normal mode: transitions to insert/visual; otherwise swallow (M5 fills in motions + edits). */
function normalKey(snap: TextSnapshot, key: VimKey): VimResult {
  if (isEscape(key)) {
    return swallow("normal", snap); // already normal; consume Escape so it doesn't bubble
  }
  // Enter insert at / after the caret (the first-cut insert commands).
  if (isPlain(key, "i")) {
    return caretInsert(snap.selStart);
  }
  if (isPlain(key, "a")) {
    return caretInsert(Math.min(lineEnd(snap.value, snap.selStart), snap.selStart + 1));
  }
  // Enter visual: v (charwise), V (linewise selects the line), Ctrl-V (treated as charwise in the first
  // cut). Selection starts as the single char at the caret (empty line -> collapsed).
  if (isPlain(key, "v") || (key.key === "v" && key.ctrl && !key.meta && !key.alt)) {
    const end = Math.min(snap.value.length, snap.selStart + 1);
    return { handled: true, mode: "visual", selStart: snap.selStart, selEnd: end };
  }
  if (key.key === "V" && !key.ctrl && !key.meta && !key.alt) {
    return {
      handled: true,
      mode: "visual",
      selStart: lineStart(snap.value, snap.selStart),
      selEnd: lineEnd(snap.value, snap.selStart),
    };
  }
  return normalMotion(snap, key) ?? swallow("normal", snap);
}

/** Visual mode: Escape / v collapse back to normal; otherwise swallow (M5 extends the selection). */
function visualKey(snap: TextSnapshot, key: VimKey): VimResult {
  if (isEscape(key) || isPlain(key, "v")) {
    // Collapse the selection to its head and return to normal.
    return caret("normal", snap.selStart);
  }
  return visualMotion(snap, key) ?? swallow("visual", snap);
}

/** Enter insert mode with a collapsed caret at `pos`. */
function caretInsert(pos: number): VimResult {
  return caret("insert", pos);
}

/**
 * Normal-mode motions (M5). Returns a result, or null to fall through to the swallow default. M4 leaves
 * this empty (every motion swallows); M5 implements h/j/k/l/w/b/0/$/gg/G + edits here.
 */
function normalMotion(_snap: TextSnapshot, _key: VimKey): VimResult | null {
  return null;
}

/** Visual-mode motions (M5): same motion keys, but they extend the selection rather than move a caret. */
function visualMotion(_snap: TextSnapshot, _key: VimKey): VimResult | null {
  return null;
}
