/**
 * Responsible for: the leading file-tree branch glyph that nests grouped rows under a header - `└`
 * on the first row, blank (width-preserving) alignment beneath. The single shared connector for the
 * tasks checklist (`tasks-panel.tsx`) and the inline-agent group (`inline-agent-row.tsx`), so both
 * indent their children in one visual language instead of hand-repeating the glyph + muted class.
 *
 * Not for: deciding which row is first, drawing the row's own status glyph, or any layout beyond the
 * one connector cell. Presentational: one boolean in, one span out.
 */

/** The leading `└` branch on the first grouped row; a blank aligned cell on the rest. */
export function TreeBranch({ first }: { first: boolean }) {
  return (
    <span className="select-none whitespace-pre text-muted-foreground/40">{first ? "└" : " "}</span>
  );
}
