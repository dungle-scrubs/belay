import { type ArtifactRef, parseImageTokens, imageTokenText as tokenText } from "@trevor/session";

/**
 * The image-token draft model (D-092): the composer keeps inline `[Image #N]` tokens IN the draft
 * text, paired with the uploaded `ArtifactRef`s in reading order. The k-th token in reading order
 * stands for the k-th ref; the displayed number N is purely positional, so removing a token
 * renumbers the rest. This module is pure - no DOM, no React - so insertion, deletion, auto-spacing,
 * and renumbering are unit-testable, and the composer hook is a thin wiring layer over it.
 *
 * The `[Image #N]` token FORMAT (parser, `tokenText`) is the cross-surface contract owned by
 * `@trevor/session` (the host strips the same tokens when projecting to the provider); only the
 * editing model below is web-side. Edits that change the token set (a selection delete, a paste)
 * are reconciled by reading the SURVIVING tokens' old numbers - so dropping any token drops the
 * right ref - then renumbering to 1..K reading order.
 */

export type { ImageTokenSpan as TokenSpan } from "@trevor/session";
// Re-export the shared format pieces so the overlay + tests keep importing from one composer module.
export { parseImageTokens, tokenText };

/** A draft pairing the visible `[Image #N]` tokens in `text` with their refs in reading order. */
export interface ImageDraft {
  readonly text: string;
  /** One ref per `[Image #N]` token, aligned to token reading order. */
  readonly refs: readonly ArtifactRef[];
}

/** The empty draft. */
export const EMPTY_DRAFT: ImageDraft = { text: "", refs: [] };

/** Rewrites every token's number to its reading-order position (1..K), leaving other text intact. */
export function renumber(text: string): string {
  let out = "";
  let last = 0;
  let n = 0;
  for (const span of parseImageTokens(text)) {
    out += text.slice(last, span.start) + tokenText(++n);
    last = span.end;
  }
  return out + text.slice(last);
}

/** The refs for the tokens inside a text slice, mapped from a source draft by their old numbers. */
function refsIn(slice: string, source: ImageDraft): ArtifactRef[] {
  return parseImageTokens(slice)
    .map((span) => source.refs[span.num - 1])
    .filter((ref): ref is ArtifactRef => ref !== undefined);
}

/** Whether a left context needs a leading space so an inserted token does not stick to a word. */
function spaceBefore(left: string): string {
  return left.length > 0 && !/\s$/.test(left) ? " " : "";
}

/** Whether a right context needs a trailing space so an inserted token does not stick to a word. */
function spaceAfter(right: string): string {
  return right.length > 0 && !/^\s/.test(right) ? " " : "";
}

/** The char index just after the reading-order `index`-th token in `text` (end of string if absent). */
function endOfToken(text: string, index: number): number {
  const span = parseImageTokens(text)[index];
  return span ? span.end : text.length;
}

/**
 * Inserts image tokens at the selection `[selStart, selEnd)` (replacing it), auto-spacing so the
 * tokens never abut adjacent words, and splicing their refs into reading order at the insertion
 * point. Returns the new draft and the cursor position just after the last inserted token. Multiple
 * refs insert as ordered tokens separated by single spaces.
 */
export function insertImages(
  draft: ImageDraft,
  selStart: number,
  selEnd: number,
  refs: readonly ArtifactRef[],
): { draft: ImageDraft; cursor: number } {
  if (refs.length === 0) {
    return { draft, cursor: selStart };
  }

  const before = draft.text.slice(0, selStart);
  const after = draft.text.slice(selEnd);
  const refsBefore = refsIn(before, draft);
  const refsAfter = refsIn(after, draft);
  const newRefs = [...refsBefore, ...refs, ...refsAfter];

  // Placeholder numbers are irrelevant - renumber rewrites every token positionally.
  const placeholders = refs.map(() => tokenText(0)).join(" ");
  const rawText = `${before}${spaceBefore(before)}${placeholders}${spaceAfter(after)}${after}`;
  const text = renumber(rawText);

  const lastInsertedIndex = refsBefore.length + refs.length - 1;
  const tokenEnd = endOfToken(text, lastInsertedIndex);
  const cursor = tokenEnd + (spaceAfter(after) ? 1 : 0);
  return { draft: { text, refs: newRefs }, cursor };
}

/**
 * Backspace (`dir = -1`) or Delete (`dir = 1`) next to a whole token removes the token AND its ref
 * in one step, collapsing a now-redundant double space. Returns the new draft + cursor, or `null`
 * when no token is immediately adjacent (so the textarea handles the keystroke normally).
 */
export function removeAdjacentToken(
  draft: ImageDraft,
  cursor: number,
  dir: -1 | 1,
): { draft: ImageDraft; cursor: number } | null {
  const spans = parseImageTokens(draft.text);
  const index = spans.findIndex((span) =>
    dir === -1 ? span.end === cursor : span.start === cursor,
  );
  if (index === -1) {
    return null;
  }

  const span = spans[index];
  if (!span) {
    return null;
  }

  const { start } = span;
  let { end } = span;
  // Collapse "word [Image #1] word" -> "word word" rather than leaving a double space.
  if (draft.text[start - 1] === " " && draft.text[end] === " ") {
    end += 1;
  }

  const rawText = draft.text.slice(0, start) + draft.text.slice(end);
  const refs = draft.refs.filter((_, i) => i !== index);
  return { draft: { text: renumber(rawText), refs }, cursor: start };
}

/**
 * Reconciles a draft after an arbitrary raw text edit (a selection delete/replace, a paste): the
 * surviving tokens keep their OLD numbers in the raw text, so each is mapped back to the ref it had,
 * and the result is renumbered to reading order. A token whose number no longer maps to a ref (e.g.
 * literal text the user typed) is dropped, keeping `refs.length` equal to the token count.
 */
export function syncDraft(prev: ImageDraft, rawText: string): ImageDraft {
  let out = "";
  let last = 0;
  let n = 0;
  const refs: ArtifactRef[] = [];
  for (const span of parseImageTokens(rawText)) {
    const ref = prev.refs[span.num - 1];
    out += rawText.slice(last, span.start);
    if (ref) {
      out += tokenText(++n);
      refs.push(ref);
    }
    // A token with no mapped ref is dropped (we never author literal image tokens).
    last = span.end;
  }
  return { text: out + rawText.slice(last), refs };
}
