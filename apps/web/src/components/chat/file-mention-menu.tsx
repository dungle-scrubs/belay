import { type FileMatch, splitWorkspacePath } from "@belay/session";
import type { ReactNode } from "react";
import { AutocompleteMenu, type AutocompleteRow } from "./autocomplete-menu";

/** The listbox id for the file-mention menu, so the composer can point aria-activedescendant at it. */
export const FILE_MENTION_LISTBOX_ID = "file-mention-menu";

/**
 * Responsible for: the `@`-file-mention list - one row per workspace match with the BASENAME
 * emphasized, the directory shown muted + end-truncated (so a deep path never wraps the row), the
 * typed query highlighted within the basename, an empty state, and a result-count / truncation
 * summary. A thin file adapter over the shared {@link AutocompleteMenu} chrome, the sibling of the
 * slash CommandMenu - same popover, active-row, focus-preserving pick behavior.
 * Not for: fuzzy filtering, the active index, key handling, or host search - the mention hook + host
 * own those; this component only renders the matches it is handed.
 */

export interface FileMentionMenuProps {
  readonly matches: readonly FileMatch[];
  readonly activeIndex: number;
  /** The raw text after `@` (may contain `/`); highlighted where it substring-matches the basename. */
  readonly query: string;
  readonly onPick: (path: string) => void;
  /** True when the host capped the result set, so the summary says "more exist - narrow your query". */
  readonly truncated?: boolean;
  /** True while the host has not yet answered the index request; the empty state reads "loading". */
  readonly loading?: boolean;
  readonly className?: string;
}

/** Highlights the first case-insensitive occurrence of `query` within `text`; plain text otherwise. */
function highlightMatch(text: string, query: string): ReactNode {
  if (query.length === 0) {
    return text;
  }
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) {
    return text;
  }
  return (
    <>
      {text.slice(0, at)}
      <span className="rounded-[2px] bg-primary/20">{text.slice(at, at + query.length)}</span>
      {text.slice(at + query.length)}
    </>
  );
}

export function FileMentionMenu({
  matches,
  activeIndex,
  query,
  onPick,
  truncated,
  loading,
  className,
}: FileMentionMenuProps) {
  const rows: AutocompleteRow[] = matches.map((match) => {
    const { basename, dir } = splitWorkspacePath(match.path);
    return {
      key: match.path,
      primary: (
        <code className="shrink-0 text-sm font-medium text-foreground">
          {highlightMatch(basename, query)}
        </code>
      ),
      secondary: dir ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span>
      ) : undefined,
    };
  });

  const summary =
    matches.length === 0
      ? undefined
      : truncated
        ? `first ${matches.length} shown - more exist, narrow your query`
        : `${matches.length} file${matches.length === 1 ? "" : "s"}`;

  return (
    <AutocompleteMenu
      className={className}
      rows={rows}
      activeIndex={activeIndex}
      onPick={onPick}
      ariaLabel="Workspace files"
      listboxId={FILE_MENTION_LISTBOX_ID}
      summary={summary}
      empty={loading ? "Loading workspace files…" : "No matching files"}
    />
  );
}
