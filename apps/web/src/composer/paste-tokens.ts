import {
  type PastePayload,
  type PasteTokenSpan,
  parsePasteTokens,
  pasteTokenFor,
  pasteTokenText,
} from "@trevor/session";
import { positionalTokenDraft } from "./positional-tokens";

/**
 * The pasted-text-token draft model (10-large-paste-placeholders): the composer keeps inline
 * `[Pasted text #N +M lines]` tokens IN the draft text, paired with the exact pasted {@link
 * PastePayload}s in reading order. The k-th token stands for the k-th payload; the displayed number N
 * is purely positional, so removing a token renumbers the rest.
 *
 * The `[Pasted text #N +M lines]` FORMAT (parser, `pasteTokenText`) is the cross-surface contract
 * owned by `@trevor/session` (the host expands the same tokens when projecting to the provider). The
 * editing INVARIANTS live once in the shared {@link positionalTokenDraft} engine; this module is the
 * paste codec (its token carries a `+M` line count read back from the span, so a renumber preserves
 * `+M` while moving only the display number) plus the thin `PasteDraft`-shaped surface. <!-- D-002 D-004 -->
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

// A paste token's `+M` line count is carried IN the token text: `render` reads it back from the span
// so a renumber preserves it, and a fresh token derives `+M` from the exact payload (via pasteTokenFor).
const engine = positionalTokenDraft<PastePayload, PasteTokenSpan>({
  parse: parsePasteTokens,
  render: (num, span) => pasteTokenText(num, span.lines),
  renderNew: (payload) => pasteTokenFor(0, payload),
});

const view = (draft: PasteDraft) => ({ text: draft.text, payloads: draft.pastes });
const asPasteDraft = (d: { text: string; payloads: readonly PastePayload[] }): PasteDraft => ({
  text: d.text,
  pastes: d.payloads,
});

/** Rewrites every paste token's NUMBER to its reading-order position (1..K) while preserving its `+M`. */
export const renumberPastes = engine.renumber;

/**
 * Inserts one pasted-text token at the selection `[selStart, selEnd)` (replacing it), auto-spacing so
 * the token never abuts adjacent words, and splicing its payload into reading order at the insertion
 * point. Returns the new draft and the cursor just after the inserted token.
 */
export function insertPaste(
  draft: PasteDraft,
  selStart: number,
  selEnd: number,
  payload: PastePayload,
): { draft: PasteDraft; cursor: number } {
  const { draft: next, cursor } = engine.insert(view(draft), selStart, selEnd, [payload]);
  return { draft: asPasteDraft(next), cursor };
}

/**
 * Removes the reading-order `index`-th paste token AND its paired payload, collapsing a redundant
 * double space, then renumbers the survivors. The explicit-remove entry point (the inspection UI's
 * remove action wires to this); a no-op when no such token exists. <!-- D-007 -->
 */
export function removePasteAt(draft: PasteDraft, index: number): PasteDraft {
  return asPasteDraft(engine.removeAt(view(draft), index));
}

/**
 * Backspace (`dir = -1`) or Delete (`dir = 1`) next to a whole token removes the token AND its
 * payload in one step. Returns the new draft + cursor, or `null` when no token is immediately adjacent.
 */
export function removeAdjacentPasteToken(
  draft: PasteDraft,
  cursor: number,
  dir: -1 | 1,
): { draft: PasteDraft; cursor: number } | null {
  const result = engine.removeAdjacent(view(draft), cursor, dir);
  return result ? { draft: asPasteDraft(result.draft), cursor: result.cursor } : null;
}

/** Reconciles a draft after an arbitrary raw text edit (a selection delete/replace, a paste). */
export function syncPasteDraft(prev: PasteDraft, rawText: string): PasteDraft {
  return asPasteDraft(engine.sync(prev.pastes, rawText));
}
