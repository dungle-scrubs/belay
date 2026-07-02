/** Shared host command-argument parsing helpers (kept tiny + pure, so each command parser tests in
 *  isolation). */

/**
 * Strips ONE surrounding pair of matched quotes from a shell-style argument (`"do the thing"` ->
 * `do the thing`), so a quoted command argument yields its inner text. Only a matched pair of the
 * same quote character (`"`/`"` or `'`/`'`) is stripped; anything shorter than two characters or
 * with mismatched ends is returned unchanged.
 */
export function stripMatchingQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}
