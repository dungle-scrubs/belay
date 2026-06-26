/**
 * The `[Image #N]` token format (D-092): the cross-surface contract for inline image references in
 * a user message's text. The web composer PRODUCES these tokens (paired with `ArtifactRef`s in
 * reading order), and the host CONSUMES them when projecting a turn to the provider - stripping the
 * literal tokens and sending the images as model image blocks in token order. Both surfaces share
 * this one parser/format so they cannot drift. Only the format lives here; the composer's editing
 * model (insert/remove/renumber) stays web-side.
 */

/** Matches one `[Image #N]` token, capturing its 1-based number. */
const IMAGE_TOKEN_RE = /\[Image #(\d+)\]/g;

/** A located token in a text: its `[`..`]` char range and the number it shows. */
export interface ImageTokenSpan {
  readonly start: number;
  readonly end: number;
  readonly num: number;
}

/** The literal token string for a display number. */
export function imageTokenText(num: number): string {
  return `[Image #${num}]`;
}

/** Every well-formed `[Image #N]` token in `text`, in reading order. */
export function parseImageTokens(text: string): ImageTokenSpan[] {
  const spans: ImageTokenSpan[] = [];
  for (const match of text.matchAll(IMAGE_TOKEN_RE)) {
    const start = match.index;
    spans.push({ start, end: start + match[0].length, num: Number(match[1]) });
  }
  return spans;
}

/**
 * Removes every `[Image #N]` token from a text and tidies the whitespace it leaves behind
 * (collapsing the resulting double spaces, trimming line edges), for the non-interleaved provider
 * path and non-vision attachment notes - so the model never sees literal token clutter.
 */
export function stripImageTokens(text: string): string {
  return text
    .replace(IMAGE_TOKEN_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+$/gm, "")
    .trim();
}
