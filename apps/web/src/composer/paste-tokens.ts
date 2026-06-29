import {
  type PastePayload,
  parsePasteTokens,
  pasteLineCount,
  pasteTokenText,
} from "@trevor/session";
import { spaceAfter, spaceBefore } from "./token-spacing";

/**
 * The pasted-text-token draft model (10-large-paste-placeholders): the composer keeps inline
 * `[Pasted text #N +M lines]` tokens IN the draft text, paired with the exact pasted {@link
 * PastePayload}s in reading order. The k-th token in reading order stands for the k-th payload; the
 * displayed number N is purely positional, so removing a token renumbers the rest. This module is
 * pure - no DOM, no React - so insertion, auto-spacing, atomic deletion, and renumbering are
 * unit-testable, and the composer is a thin wiring layer over it.
 *
 * This deliberately mirrors `image-tokens.ts`: same insert/remove/sync/renumber semantics, a
 * different token namespace and payload type. The `[Pasted text #N +M lines]` FORMAT (parser,
 * `pasteTokenText`) is the cross-surface contract owned by `@trevor/session` (the host expands the
 * same tokens when projecting to the provider); only the editing model below is web-side. A
 * surviving token keeps its OWN line count `+M` (the payload is unchanged by an edit); only the
 * display number N is rewritten by renumbering. <!-- D-002 D-004 -->
 */

export type { PasteTokenSpan } from "@trevor/session";
export { parsePasteTokens, pasteTokenText };

/** A draft pairing the visible `[Pasted text #N +M lines]` tokens in `text` with their payloads. */
export interface PasteDraft {
  readonly text: string;
  /** One payload per `[Pasted text #N +M lines]` token, aligned to token reading order. */
  readonly pastes: readonly PastePayload[];
}

/** The empty paste draft. */
export const EMPTY_PASTE_DRAFT: PasteDraft = { text: "", pastes: [] };

/**
 * Rewrites every paste token's NUMBER to its reading-order position (1..K) while preserving its line
 * count `+M`, leaving other text intact. A token's `+M` comes from the unchanged payload, so an edit
 * never re-derives it - only the display number moves.
 */
export function renumberPastes(text: string): string {
  let out = "";
  let last = 0;
  let n = 0;
  for (const span of parsePasteTokens(text)) {
    out += text.slice(last, span.start) + pasteTokenText(++n, span.lines);
    last = span.end;
  }
  return out + text.slice(last);
}

/** The payloads for the tokens inside a text slice, mapped from a source draft by their old numbers. */
function pastesIn(slice: string, source: PasteDraft): PastePayload[] {
  return parsePasteTokens(slice)
    .map((span) => source.pastes[span.num - 1])
    .filter((payload): payload is PastePayload => payload !== undefined);
}

/** The char index just after the reading-order `index`-th token in `text` (end of string if absent). */
function endOfToken(text: string, index: number): number {
  const span = parsePasteTokens(text)[index];
  return span ? span.end : text.length;
}

/**
 * Inserts one pasted-text token at the selection `[selStart, selEnd)` (replacing it), auto-spacing
 * so the token never abuts adjacent words, and splicing its payload into reading order at the
 * insertion point. Returns the new draft and the cursor position just after the inserted token.
 */
export function insertPaste(
  draft: PasteDraft,
  selStart: number,
  selEnd: number,
  payload: PastePayload,
): { draft: PasteDraft; cursor: number } {
  const before = draft.text.slice(0, selStart);
  const after = draft.text.slice(selEnd);
  const pastesBefore = pastesIn(before, draft);
  const pastesAfter = pastesIn(after, draft);
  const newPastes = [...pastesBefore, payload, ...pastesAfter];

  // The placeholder number is irrelevant - renumber rewrites every token positionally; only the
  // line count `+M` is meaningful and comes from the exact payload.
  const placeholder = pasteTokenText(0, pasteLineCount(payload.text));
  const rawText = `${before}${spaceBefore(before)}${placeholder}${spaceAfter(after)}${after}`;
  const text = renumberPastes(rawText);

  const tokenEnd = endOfToken(text, pastesBefore.length);
  const cursor = tokenEnd + (spaceAfter(after) ? 1 : 0);
  return { draft: { text, pastes: newPastes }, cursor };
}

/**
 * Backspace (`dir = -1`) or Delete (`dir = 1`) next to a whole token removes the token AND its
 * payload in one step, collapsing a now-redundant double space. Returns the new draft + cursor, or
 * `null` when no token is immediately adjacent (so the textarea handles the keystroke normally).
 */
export function removeAdjacentPasteToken(
  draft: PasteDraft,
  cursor: number,
  dir: -1 | 1,
): { draft: PasteDraft; cursor: number } | null {
  const spans = parsePasteTokens(draft.text);
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
  // Collapse "word [Pasted text #1 +3 lines] word" -> "word word" rather than a double space.
  if (draft.text[start - 1] === " " && draft.text[end] === " ") {
    end += 1;
  }

  const rawText = draft.text.slice(0, start) + draft.text.slice(end);
  const pastes = draft.pastes.filter((_, i) => i !== index);
  return { draft: { text: renumberPastes(rawText), pastes }, cursor: start };
}

/**
 * Reconciles a draft after an arbitrary raw text edit (a selection delete/replace, a paste): the
 * surviving tokens keep their OLD numbers in the raw text, so each is mapped back to the payload it
 * had, and the result is renumbered to reading order. A token whose number no longer maps to a
 * payload (e.g. literal text the user typed) is dropped, keeping `pastes.length` equal to the token
 * count.
 */
export function syncPasteDraft(prev: PasteDraft, rawText: string): PasteDraft {
  let out = "";
  let last = 0;
  let n = 0;
  const pastes: PastePayload[] = [];
  for (const span of parsePasteTokens(rawText)) {
    const payload = prev.pastes[span.num - 1];
    out += rawText.slice(last, span.start);
    if (payload) {
      out += pasteTokenText(++n, span.lines);
      pastes.push(payload);
    }
    // A token with no mapped payload is dropped (we never author literal paste tokens).
    last = span.end;
  }
  return { text: out + rawText.slice(last), pastes };
}
