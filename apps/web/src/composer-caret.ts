/**
 * Caret-line predicates for the composer's prompt-history navigation (D-084). ArrowUp recalls the
 * previous prompt only when moving up wouldn't otherwise move the caret within the text - i.e. the
 * caret is on the first line; ArrowDown advances through recalled prompts only from the last line.
 * Pure over (value, caret index) so the eligibility rule is unit-tested without a DOM.
 */

/** True when the caret sits on the first line of the value (no newline precedes it). */
export function caretOnFirstLine(value: string, caret: number): boolean {
  return value.lastIndexOf("\n", caret - 1) === -1;
}

/** True when the caret sits on the last line of the value (no newline at or after it). */
export function caretOnLastLine(value: string, caret: number): boolean {
  return value.indexOf("\n", caret) === -1;
}
