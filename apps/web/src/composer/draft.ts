import type { ArtifactRef, PastePayload } from "@trevor/session";
import {
  type ImageDraft,
  insertImages as insertImageTokens,
  removeAdjacentToken as removeAdjacentImageToken,
  syncDraft as syncImageDraft,
} from "./image-tokens";
import {
  insertPaste as insertPasteToken,
  type PasteDraft,
  removeAdjacentPasteToken,
  syncPasteDraft,
} from "./paste-tokens";

/**
 * The composer draft: one `text` carrying BOTH inline `[Image #N]` tokens (paired to uploaded image
 * refs) and `[Pasted text #N +M lines]` tokens (paired to exact pasted payloads), each in its own
 * reading-order namespace. The two token kinds never share a number: image tokens count 1..K among
 * themselves and paste tokens count 1..M among themselves, even when interleaved.
 *
 * This is the thin composition over the two pure token models (image-tokens.ts, paste-tokens.ts):
 * each operation touches only its own token kind and passes the other's tokens through as ordinary
 * surrounding text, so editing one kind never disturbs the other's pairing or numbering. <!-- D-004 -->
 */
export interface ComposerDraft {
  readonly text: string;
  /** Image refs paired to the draft's `[Image #N]` tokens, in reading order. */
  readonly imageRefs: readonly ArtifactRef[];
  /** Pasted payloads paired to the draft's `[Pasted text #N +M lines]` tokens, in reading order. */
  readonly pastes: readonly PastePayload[];
}

/** The empty composer draft. */
export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: "", imageRefs: [], pastes: [] };

const imageView = (draft: ComposerDraft): ImageDraft => ({
  text: draft.text,
  refs: draft.imageRefs,
});

const pasteView = (draft: ComposerDraft): PasteDraft => ({
  text: draft.text,
  pastes: draft.pastes,
});

/**
 * Reconciles BOTH token kinds against an arbitrary raw text edit: image refs first (renumbering
 * `[Image #N]`, dropping image tokens whose number no longer maps), then pasted payloads against the
 * result. Because each sync rewrites only its own tokens and copies the rest verbatim, composing
 * them keeps every surviving token paired to the right ref/payload. Surviving paste numbers are read
 * against `prev`, so the image pass (which leaves paste tokens untouched) does not perturb them.
 */
export function syncComposerDraft(prev: ComposerDraft, rawText: string): ComposerDraft {
  const img = syncImageDraft(imageView(prev), rawText);
  const paste = syncPasteDraft(pasteView(prev), img.text);
  return { text: paste.text, imageRefs: img.refs, pastes: paste.pastes };
}

/** Inserts image tokens at the selection, leaving the paste pairing intact. */
export function insertImages(
  draft: ComposerDraft,
  selStart: number,
  selEnd: number,
  refs: readonly ArtifactRef[],
): { draft: ComposerDraft; cursor: number } {
  const { draft: next, cursor } = insertImageTokens(imageView(draft), selStart, selEnd, refs);
  return { draft: { text: next.text, imageRefs: next.refs, pastes: draft.pastes }, cursor };
}

/** Inserts one pasted-text token at the selection, leaving the image pairing intact. */
export function insertPaste(
  draft: ComposerDraft,
  selStart: number,
  selEnd: number,
  payload: PastePayload,
): { draft: ComposerDraft; cursor: number } {
  const { draft: next, cursor } = insertPasteToken(pasteView(draft), selStart, selEnd, payload);
  return { draft: { text: next.text, imageRefs: draft.imageRefs, pastes: next.pastes }, cursor };
}

/**
 * Backspace/Delete next to a whole token removes the token + its paired ref/payload atomically. Image
 * tokens are checked first, then paste tokens; returns the new draft + cursor, or `null` when no
 * token is immediately adjacent (so the textarea handles the keystroke normally).
 */
export function removeAdjacentToken(
  draft: ComposerDraft,
  cursor: number,
  dir: -1 | 1,
): { draft: ComposerDraft; cursor: number } | null {
  const img = removeAdjacentImageToken(imageView(draft), cursor, dir);
  if (img) {
    return {
      draft: { text: img.draft.text, imageRefs: img.draft.refs, pastes: draft.pastes },
      cursor: img.cursor,
    };
  }

  const paste = removeAdjacentPasteToken(pasteView(draft), cursor, dir);
  if (paste) {
    return {
      draft: { text: paste.draft.text, imageRefs: draft.imageRefs, pastes: paste.draft.pastes },
      cursor: paste.cursor,
    };
  }

  return null;
}
