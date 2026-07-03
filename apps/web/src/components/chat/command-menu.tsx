import type { CommandSpec } from "@trevor/session";
import { AutocompleteMenu, type AutocompleteRow } from "./autocomplete-menu";

/**
 * The slash-command autocomplete list: one row per matching command, the active row highlighted, and
 * the typed prefix highlighted within each command label.
 *
 * A thin command adapter over the shared {@link AutocompleteMenu} chrome (the sibling of the
 * `@`-file-mention menu). Purely presentational - the caller owns filtering, the active index, and
 * keyboard handling (on the input). Positioning is the caller's too: pass an absolute/`bottom-full`
 * className so it overlays above the composer instead of pushing the transcript up.
 */
export function CommandMenu({
  matches,
  activeIndex,
  query,
  onPick,
  className,
}: {
  matches: readonly CommandSpec[];
  activeIndex: number;
  /** The typed slash query (includes the leading "/"); its length is the matched prefix. */
  query: string;
  onPick: (name: string) => void;
  className?: string;
}) {
  const matchLen = query.length;
  const rows: AutocompleteRow[] = matches.map((c) => {
    const display = c.usage ?? c.name;
    return {
      key: c.name,
      primary: (
        <code className="text-sm font-semibold text-primary">
          {matchLen > 0 ? (
            <>
              <span className="rounded-[2px] bg-primary/20">{display.slice(0, matchLen)}</span>
              <span className="text-muted-foreground">{display.slice(matchLen)}</span>
            </>
          ) : (
            display
          )}
        </code>
      ),
      secondary: <span className="text-xs text-muted-foreground">{c.summary}</span>,
    };
  });

  return (
    <AutocompleteMenu
      className={className}
      rows={rows}
      activeIndex={activeIndex}
      onPick={onPick}
      ariaLabel="Slash commands"
    />
  );
}
