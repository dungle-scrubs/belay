/**
 * The `[Pasted text #N +M lines]` token format (10-large-paste-placeholders): the cross-surface
 * contract for a large plain-text paste inlined into a user message's text. The web composer
 * PRODUCES these tokens (paired with the exact pasted payload in reading order), and the host
 * CONSUMES them when projecting a turn to the provider - expanding each token back into its full
 * payload at the token's position so the model receives the exact pasted text, never the compact
 * placeholder. Both surfaces share this one parser/format so they cannot drift. Only the format +
 * threshold policy live here; the composer's editing model (insert/remove/renumber) stays web-side.
 *
 * Mirrors `image-tokens.ts` (the `[Image #N]` precedent) deliberately: a compact visible token in
 * the textarea paired to hidden payload metadata, expanded only at provider-projection time. <!-- D-001 D-002 -->
 */

/** The exact pasted payload paired to one `[Pasted text #N +M lines]` token. */
export interface PastePayload {
  /** The pasted text, preserved exactly (byte-for-byte: CRLF, trailing newlines, Unicode). */
  readonly text: string;
}

/** Matches one `[Pasted text #N +M lines]` token, capturing its 1-based number and its line count. */
const PASTE_TOKEN_RE = /\[Pasted text #(\d+) \+(\d+) lines\]/g;

/** A located paste token in a text: its `[`..`]` char range, the number it shows, and its line count. */
export interface PasteTokenSpan {
  readonly start: number;
  readonly end: number;
  readonly num: number;
  readonly lines: number;
}

/**
 * The display line count of a payload: the number of text lines, derived SEPARATELY from the exact
 * payload (D-002). CRLF / CR are normalized to a single break for counting only, and a single
 * trailing newline does not add a phantom empty line, so the count reads as a human would count
 * lines while the stored payload keeps its exact bytes.
 */
export function pasteLineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  const breaks = normalized.match(/\n/g)?.length ?? 0;
  return breaks + (normalized.endsWith("\n") ? 0 : 1);
}

/** The literal token string for a display number and line count. */
export function pasteTokenText(num: number, lines: number): string {
  return `[Pasted text #${num} +${lines} lines]`;
}

/** The token for a payload at display number `num` (its line count derived from the exact text). */
export function pasteTokenFor(num: number, payload: PastePayload): string {
  return pasteTokenText(num, pasteLineCount(payload.text));
}

/** Every well-formed `[Pasted text #N +M lines]` token in `text`, in reading order. */
export function parsePasteTokens(text: string): PasteTokenSpan[] {
  const spans: PasteTokenSpan[] = [];
  for (const match of text.matchAll(PASTE_TOKEN_RE)) {
    const start = match.index;
    spans.push({
      start,
      end: start + match[0].length,
      num: Number(match[1]),
      lines: Number(match[2]),
    });
  }
  return spans;
}

/**
 * Removes every `[Pasted text #N +M lines]` token from a text and tidies the whitespace it leaves
 * behind, for the legacy / missing-payload path (a token with no paired payload, e.g. a draft
 * restored without its in-memory payloads) so the model never sees a bare placeholder.
 */
export function stripPasteTokens(text: string): string {
  return text
    .replace(PASTE_TOKEN_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+$/gm, "")
    .trim();
}

/** The line and character thresholds above which a plain-text paste becomes a token. <!-- D-003 --> */
export interface PasteThresholds {
  readonly lines: number;
  readonly chars: number;
}

/**
 * The default large-paste thresholds: a paste of 20+ lines OR 1500+ characters tokenizes; anything
 * smaller stays literal text. Chosen so an ordinary multi-line prompt stays editable while a genuine
 * dump (a long file, a wide single-line blob) collapses to a compact token. Configurable per call so
 * boundary behavior is testable and tunable. <!-- D-003 -->
 */
export const DEFAULT_PASTE_THRESHOLDS: PasteThresholds = { lines: 20, chars: 1500 };

/**
 * Whether a pasted plain-text payload is "large" enough to tokenize: at or above EITHER the line OR
 * the character threshold. A boundary value (exactly the threshold) tokenizes; one below stays
 * literal. The character test uses the exact byte length; the line test uses the derived line count.
 */
export function isLargePaste(
  text: string,
  thresholds: PasteThresholds = DEFAULT_PASTE_THRESHOLDS,
): boolean {
  return text.length >= thresholds.chars || pasteLineCount(text) >= thresholds.lines;
}
