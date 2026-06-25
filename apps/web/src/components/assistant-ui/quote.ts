/**
 * Pure helpers for "quote selection into the composer", kept apart from the React
 * toolbar so they unit-test without a DOM. The toolbar (quote-selection-toolbar.tsx)
 * detects the selection and positions the UI; these shape the text it inserts.
 */

/**
 * Wraps each line of `selected` in a markdown blockquote marker. Empty lines become a
 * bare `>` so the quote stays one contiguous block.
 */
export const toBlockquote = (selected: string): string =>
  selected
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

/**
 * Builds the new composer value when quoting `selected` into a composer that already
 * holds `existing`. The quote is appended below any existing text, separated by a blank
 * line, and the returned `cursor` lands on the empty line beneath the quote (GitHub-style)
 * so the user can type their reference straight away.
 */
export const buildQuotedComposerText = (
  existing: string,
  selected: string,
): { value: string; cursor: number } => {
  const quote = toBlockquote(selected.trim());
  const base = existing.replace(/\s+$/, "");
  const prefix = base.length > 0 ? `${base}\n\n` : "";
  const value = `${prefix}${quote}\n\n`;

  return { value, cursor: value.length };
};
