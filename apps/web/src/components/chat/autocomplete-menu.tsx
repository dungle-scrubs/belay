import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Responsible for: the shared composer-autocomplete chrome - the bordered popover, one row per item
 * with the active row highlighted, the focus-preserving mouse-down pick, an optional muted summary
 * footer, and the listbox/option ARIA roles. It draws ANY item shape: the caller composes each row's
 * emphasized `primary` + muted `secondary` content, so the slash-command menu and the `@`-file-mention
 * menu share one presentation instead of forking a second menu.
 * Not for: filtering, the active index, key handling, or what an item MEANS - the caller (a menu hook)
 * owns all of that; this component only renders rows and reports a pick by key.
 */

export interface AutocompleteRow {
  /** Stable React key AND the value handed to {@link AutocompleteMenuProps.onPick} when chosen. */
  readonly key: string;
  /** The emphasized primary content (a command label / a file basename). */
  readonly primary: ReactNode;
  /** Optional muted trailing content (a command summary / a directory path). */
  readonly secondary?: ReactNode;
}

export interface AutocompleteMenuProps {
  readonly rows: readonly AutocompleteRow[];
  /** The highlighted row (the caller's owned active index); rows outside range highlight nothing. */
  readonly activeIndex: number;
  readonly onPick: (key: string) => void;
  /** Screen-reader label for the listbox (e.g. "Slash commands", "Workspace files"). */
  readonly ariaLabel: string;
  /** DOM id for the listbox; each option is `${listboxId}-opt-${i}`, so the composer textarea can
   *  point `aria-activedescendant`/`aria-controls` at the active row (see {@link activeOptionId}). */
  readonly listboxId: string;
  /** Optional muted footer, e.g. a result count / a "more exist" truncation notice. */
  readonly summary?: ReactNode;
  /** Shown in place of the rows when there are none (e.g. "No matching files"). */
  readonly empty?: ReactNode;
  /** Positioning is the caller's: pass an absolute/`bottom-full` class to overlay above the composer. */
  readonly className?: string;
}

/** The DOM id of the active option in a menu with the given `listboxId`, for `aria-activedescendant`. */
export function activeOptionId(listboxId: string, activeIndex: number): string {
  return `${listboxId}-opt-${activeIndex}`;
}

export function AutocompleteMenu({
  rows,
  activeIndex,
  onPick,
  ariaLabel,
  listboxId,
  summary,
  empty,
  className,
}: AutocompleteMenuProps) {
  const listboxRef = useRef<HTMLDivElement>(null);

  // Arrow-key navigation moves `activeIndex` while focus stays in the composer; without this the
  // highlight can scroll out of the capped list. Scroll the active option back into view, cheapest
  // first (`block: "nearest"` only scrolls when the option is already out of view).
  useEffect(() => {
    const listbox = listboxRef.current;
    if (!listbox) {
      return;
    }
    const active = listbox.querySelector<HTMLElement>(
      `[id="${activeOptionId(listboxId, activeIndex)}"]`,
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listboxId]);

  return (
    <div className={cn("overflow-hidden border border-border bg-popover shadow-lg", className)}>
      {rows.length === 0 && empty ? (
        <div className="px-3 py-1.5 text-sm text-muted-foreground">{empty}</div>
      ) : (
        // The row list is capped at 60vh and scrolls internally so a long match list (e.g. dozens of
        // workspace files) can never grow the popover off the top of the screen. `max-h` (not `h`)
        // keeps a short list at natural height - no empty box. The empty/loading state and the summary
        // footer stay OUTSIDE the scroll area, so an empty menu never scrolls and the footer stays pinned.
        <div
          id={listboxId}
          ref={listboxRef}
          role="listbox"
          aria-label={ariaLabel}
          className="max-h-[60vh] flex flex-col overflow-y-auto"
        >
          {rows.map((row, i) => (
            <button
              key={row.key}
              id={activeOptionId(listboxId, i)}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              // onMouseDown (not onClick) so the composer input keeps focus through the pick.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(row.key);
              }}
              className={cn(
                // Stable row height (single-line, py-1.5, baseline-aligned) so the list never jitters
                // as matches change.
                "flex w-full items-baseline gap-2 px-3 py-1.5 text-left",
                i === activeIndex ? "bg-accent" : "hover:bg-secondary",
              )}
            >
              {row.primary}
              {row.secondary}
            </button>
          ))}
        </div>
      )}
      {summary ? (
        <div className="border-t border-border px-3 py-1 text-xs text-muted-foreground">
          {summary}
        </div>
      ) : null}
    </div>
  );
}
