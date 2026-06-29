/**
 * Auto-spacing helpers shared by the inline composer token models (image tokens and pasted-text
 * tokens): when a token is spliced into the draft text it must not abut an adjacent word. Pure and
 * tiny, factored out so both token modules space identically. <!-- D-004 -->
 */

/** A leading space when the left context ends in a non-space word char, else "". */
export function spaceBefore(left: string): string {
  return left.length > 0 && !/\s$/.test(left) ? " " : "";
}

/** A trailing space when the right context starts with a non-space word char, else "". */
export function spaceAfter(right: string): string {
  return right.length > 0 && !/^\s/.test(right) ? " " : "";
}
