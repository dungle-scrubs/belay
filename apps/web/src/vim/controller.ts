import type { VimMode } from "./mode";

/**
 * The prompt-local Vim controller (plan 06, M4/M5): a small, framework-agnostic state machine over a
 * textarea snapshot, chosen over `vimeejs/vimee` (decision D-008) so it yields cleanly to native typing
 * and the composer's existing key precedence. Pure - no DOM, no React - so it is unit-tested without
 * jsdom (M4 REFACTOR).
 *
 * It takes the current {@link VimState} (mode + a one-key pending prefix + the visual anchor) and a
 * `{ value, selStart, selEnd }` snapshot and a key, and returns either "not handled" (let the textarea /
 * App handle it natively: insert typing, Enter-submit, the slash menu, history recall, IME) or "handled"
 * with the next state + selection (+ optional value) for the caller to apply and `preventDefault`.
 *
 * Modes: a focused prompt starts in `insert` (native typing); Escape -> `normal`; `i`/`a` -> insert;
 * `v`/`V`/Ctrl-V -> `visual`; Escape/`v` leave visual. In normal/visual every otherwise-unhandled
 * printable key is SWALLOWED (so `j` never types a "j"). Editing is deliberately conservative (M5
 * REFACTOR): normal `x` deletes a char, visual `d`/`x` delete the selection; yank is left to the native
 * clipboard (Cmd/Ctrl-C copies the live visual selection), and ambiguous Vim features are deferred.
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

export interface VimState {
  readonly mode: VimMode;
  /** A pending prefix awaiting its second key (only `g`, for `gg`); cleared after the next key. */
  readonly pending?: "g";
  /** The fixed end of the visual selection; the moving cursor is the snapshot's other end. */
  readonly anchor?: number;
}

/**
 * The controller's verdict. `handled: false` -> the caller does nothing native handling proceeds.
 * `handled: true` -> apply `selStart`/`selEnd` (and `value` if present) to the textarea, set `state`,
 * `preventDefault`. `state` is always the next controller state to store.
 */
export type VimResult =
  | { readonly handled: false; readonly state: VimState }
  | {
      readonly handled: true;
      readonly state: VimState;
      readonly selStart: number;
      readonly selEnd: number;
      readonly value?: string;
    };

/** The initial state for a freshly-focused Vim-enabled prompt: insert mode. */
export const INITIAL_VIM_STATE: VimState = { mode: "insert" };

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

/** The index of the newline ending the line containing `pos`, or the value length. */
export function lineEnd(value: string, pos: number): number {
  const nl = value.indexOf("\n", pos);
  return nl === -1 ? value.length : nl;
}

// --- character-class word motions (vim `w`/`b`: a word is a run of word-chars OR of punctuation) ---

type CharClass = "space" | "word" | "punct";
function classOf(ch: string): CharClass {
  if (/\s/.test(ch)) {
    return "space";
  }
  return /[A-Za-z0-9_]/.test(ch) ? "word" : "punct";
}

/** The start of the next word at or after `pos` (vim `w`). */
function wordForward(value: string, pos: number): number {
  const n = value.length;
  let i = pos;
  if (i >= n) {
    return n;
  }
  const cls = classOf(value[i] as string);
  if (cls !== "space") {
    while (i < n && classOf(value[i] as string) === cls) {
      i++;
    }
  }
  while (i < n && classOf(value[i] as string) === "space") {
    i++;
  }
  return i;
}

/** The start of the current/previous word before `pos` (vim `b`). */
function wordBack(value: string, pos: number): number {
  let i = pos;
  if (i <= 0) {
    return 0;
  }
  i--;
  while (i > 0 && classOf(value[i] as string) === "space") {
    i--;
  }
  const cls = classOf(value[i] as string);
  while (i > 0 && classOf(value[i - 1] as string) === cls) {
    i--;
  }
  return i;
}

/** Vertical move by `delta` lines, keeping the column (clamped to the target line's length). */
function verticalMove(value: string, pos: number, delta: -1 | 1): number {
  const start = lineStart(value, pos);
  const col = pos - start;
  if (delta === 1) {
    const end = lineEnd(value, pos);
    if (end >= value.length) {
      return pos; // last line, no line below
    }
    const nextStart = end + 1;
    return Math.min(nextStart + col, lineEnd(value, nextStart));
  }
  if (start === 0) {
    return pos; // first line, no line above
  }
  const prevStart = lineStart(value, start - 1);
  return Math.min(prevStart + col, lineEnd(value, prevStart));
}

/** The caret position a motion key moves to, or null if the key is not a (cursor) motion. */
function motionTarget(
  value: string,
  pos: number,
  key: VimKey,
  pending: "g" | undefined,
): number | null {
  if (pending === "g") {
    return isPlain(key, "g") ? 0 : null; // gg -> document start
  }
  if (isPlain(key, "h") || key.key === "ArrowLeft") {
    return Math.max(lineStart(value, pos), pos - 1);
  }
  if (isPlain(key, "l") || key.key === "ArrowRight") {
    return Math.min(lineEnd(value, pos), pos + 1);
  }
  if (isPlain(key, "j") || key.key === "ArrowDown") {
    return verticalMove(value, pos, 1);
  }
  if (isPlain(key, "k") || key.key === "ArrowUp") {
    return verticalMove(value, pos, -1);
  }
  if (isPlain(key, "0")) {
    return lineStart(value, pos);
  }
  if (isPlain(key, "$")) {
    return lineEnd(value, pos);
  }
  if (isPlain(key, "w")) {
    return wordForward(value, pos);
  }
  if (isPlain(key, "b")) {
    return wordBack(value, pos);
  }
  if (key.key === "G" && !key.ctrl && !key.meta && !key.alt) {
    return value.length; // last line / document end
  }
  return null;
}

function handled(state: VimState, selStart: number, selEnd: number, value?: string): VimResult {
  return value === undefined
    ? { handled: true, state, selStart, selEnd }
    : { handled: true, state, selStart, selEnd, value };
}

/** Dispatches a key against the current state. The entry point both surfaces (composer + editor) call. */
export function handleVimKey(state: VimState, snap: TextSnapshot, key: VimKey): VimResult {
  if (state.mode === "insert") {
    return insertKey(snap, key);
  }
  if (state.mode === "normal") {
    return normalKey(state, snap, key);
  }
  return visualKey(state, snap, key);
}

/** Insert mode is native typing, EXCEPT Escape -> normal (with the vim cursor-left-on-exit nudge). */
function insertKey(snap: TextSnapshot, key: VimKey): VimResult {
  if (isEscape(key)) {
    const pos = Math.max(lineStart(snap.value, snap.selStart), snap.selStart - 1);
    return handled({ mode: "normal" }, pos, pos);
  }
  return { handled: false, state: { mode: "insert" } };
}

/**
 * Keys that pass THROUGH the controller even in normal/visual mode, so the composer's own behaviors
 * keep working: Enter (submit), and the OS / clipboard chords (Cmd+anything, and Ctrl chords other than
 * Ctrl-V, which is vim visual-block). Insert-mode typing is already native, so this only matters for
 * normal/visual. In insert mode, Cmd/Ctrl-V paste and Enter pass through here too.
 */
function nativeChord(key: VimKey): boolean {
  if (key.meta) {
    return true;
  }
  if (key.ctrl) {
    return key.key !== "v";
  }
  return key.key === "Enter";
}

function normalKey(state: VimState, snap: TextSnapshot, key: VimKey): VimResult {
  const pending = state.pending;
  // A pending `g` consumes exactly the next key: `gg` jumps to the start, anything else cancels.
  if (pending === "g") {
    const target = motionTarget(snap.value, snap.selStart, key, "g");
    return target === null
      ? handled({ mode: "normal" }, snap.selStart, snap.selEnd)
      : handled({ mode: "normal" }, target, target);
  }
  // Enter-submit + OS chords stay native; a SECOND Escape (already normal) bubbles so it can cancel a
  // running turn / clear the draft (the composer's existing Escape semantics).
  if (nativeChord(key) || isEscape(key)) {
    return { handled: false, state: { mode: "normal" } };
  }
  if (isPlain(key, "g")) {
    return handled({ mode: "normal", pending: "g" }, snap.selStart, snap.selEnd);
  }
  if (isPlain(key, "i")) {
    return handled({ mode: "insert" }, snap.selStart, snap.selStart);
  }
  if (isPlain(key, "a")) {
    const pos = Math.min(lineEnd(snap.value, snap.selStart), snap.selStart + 1);
    return handled({ mode: "insert" }, pos, pos);
  }
  if (isPlain(key, "x")) {
    // Delete the char under the caret (never across a line break or past the end).
    const at = snap.selStart;
    if (at >= snap.value.length || snap.value[at] === "\n") {
      return handled({ mode: "normal" }, at, at);
    }
    const value = snap.value.slice(0, at) + snap.value.slice(at + 1);
    return handled({ mode: "normal" }, at, at, value);
  }
  if (isPlain(key, "v") || (key.key === "v" && key.ctrl && !key.meta && !key.alt)) {
    const end = Math.min(snap.value.length, snap.selStart + 1);
    return handled({ mode: "visual", anchor: snap.selStart }, snap.selStart, end);
  }
  if (key.key === "V" && !key.ctrl && !key.meta && !key.alt) {
    const start = lineStart(snap.value, snap.selStart);
    return handled({ mode: "visual", anchor: start }, start, lineEnd(snap.value, snap.selStart));
  }
  const target = motionTarget(snap.value, snap.selStart, key, undefined);
  if (target !== null) {
    return handled({ mode: "normal" }, target, target);
  }
  return handled({ mode: "normal" }, snap.selStart, snap.selEnd); // swallow
}

function visualKey(state: VimState, snap: TextSnapshot, key: VimKey): VimResult {
  // Enter + OS chords (incl. native Cmd/Ctrl-C copying the live selection) stay native.
  if (nativeChord(key)) {
    return { handled: false, state };
  }
  if (isEscape(key) || isPlain(key, "v")) {
    return handled({ mode: "normal" }, snap.selStart, snap.selStart);
  }
  if (isPlain(key, "d") || isPlain(key, "x")) {
    const value = snap.value.slice(0, snap.selStart) + snap.value.slice(snap.selEnd);
    return handled({ mode: "normal" }, snap.selStart, snap.selStart, value);
  }
  // Motions move the cursor (the end that is NOT the anchor) and re-form the selection.
  const anchor = state.anchor ?? snap.selStart;
  const cursor = anchor === snap.selStart ? snap.selEnd : snap.selStart;
  const target = motionTarget(snap.value, cursor, key, undefined);
  if (target === null) {
    return handled({ mode: "visual", anchor }, snap.selStart, snap.selEnd); // swallow
  }
  return handled({ mode: "visual", anchor }, Math.min(anchor, target), Math.max(anchor, target));
}
