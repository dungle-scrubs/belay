import {
  type ArtifactRef,
  type ImageTokenSpan,
  parseImageTokens,
  imageTokenText as tokenText,
} from "@belay/session";
import { positionalTokenDraft } from "./positional-tokens";

/**
 * The image-token draft model (D-092): the composer keeps inline `[Image #N]` tokens IN the draft
 * text, paired with the uploaded `ArtifactRef`s in reading order. The k-th token stands for the k-th
 * ref; the displayed number N is purely positional, so removing a token renumbers the rest.
 *
 * The `[Image #N]` token FORMAT (parser, `tokenText`) is the cross-surface contract owned by
 * `@belay/session` (the host strips the same tokens when projecting to the provider). The editing
 * INVARIANTS (insert/auto-space/atomic-remove/renumber/reconcile) live once in the shared
 * {@link positionalTokenDraft} engine; this module is the image codec (which token FORMAT to edit)
 * plus the thin `ImageDraft`-shaped surface the composer + overlay import.
 */

export type { ImageTokenSpan as TokenSpan } from "@belay/session";
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

// An `[Image #N]` token carries only its positional number, so `render` ignores the span and a fresh
// token needs nothing from the ref (renumber overwrites the placeholder 0).
const engine = positionalTokenDraft<ArtifactRef, ImageTokenSpan>({
  parse: parseImageTokens,
  render: (num) => tokenText(num),
  renderNew: () => tokenText(0),
});

const view = (draft: ImageDraft) => ({ text: draft.text, payloads: draft.refs });
const asImageDraft = (d: { text: string; payloads: readonly ArtifactRef[] }): ImageDraft => ({
  text: d.text,
  refs: d.payloads,
});

/** Rewrites every token's number to its reading-order position (1..K), leaving other text intact. */
export const renumber = engine.renumber;

/**
 * Inserts image tokens at the selection `[selStart, selEnd)` (replacing it), auto-spacing so the
 * tokens never abut adjacent words, and splicing their refs into reading order at the insertion
 * point. Returns the new draft and the cursor just after the last inserted token.
 */
export function insertImages(
  draft: ImageDraft,
  selStart: number,
  selEnd: number,
  refs: readonly ArtifactRef[],
): { draft: ImageDraft; cursor: number } {
  const { draft: next, cursor } = engine.insert(view(draft), selStart, selEnd, refs);
  return { draft: asImageDraft(next), cursor };
}

/**
 * Backspace (`dir = -1`) or Delete (`dir = 1`) next to a whole token removes the token AND its ref in
 * one step. Returns the new draft + cursor, or `null` when no token is immediately adjacent.
 */
export function removeAdjacentToken(
  draft: ImageDraft,
  cursor: number,
  dir: -1 | 1,
): { draft: ImageDraft; cursor: number } | null {
  const result = engine.removeAdjacent(view(draft), cursor, dir);
  return result ? { draft: asImageDraft(result.draft), cursor: result.cursor } : null;
}

/** Reconciles a draft after an arbitrary raw text edit (a selection delete/replace, a paste). */
export function syncDraft(prev: ImageDraft, rawText: string): ImageDraft {
  return asImageDraft(engine.sync(prev.refs, rawText));
}
