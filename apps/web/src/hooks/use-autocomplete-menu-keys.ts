import { type KeyboardEvent as ReactKeyboardEvent, type SetStateAction, useCallback } from "react";

/**
 * Responsible for: the shared Arrow-cycle / Tab-accept / Enter-accept / Escape-dismiss key handling
 * behind a composer autocomplete menu (the sibling of `AutocompleteMenu`'s shared RENDERING) - the
 * slash `CommandMenu` and the `@`-file-mention menu drove nearly identical key-handling logic before
 * this extraction, differing only in what "accept" and "escape" mean for each feature. This hook owns
 * ONLY the key routing: which key does what, and in what order. Each caller supplies its own
 * `onAccept`/`onEscape` for its feature-specific accept payload and dismiss bookkeeping.
 *
 * Escape is handled BEFORE requiring a selected match to exist, so a menu that is "open" with zero
 * matches (e.g. the file-mention menu while loading or with no results) still lets Escape dismiss it -
 * a menu whose `open` already implies at least one match (the slash menu) is unaffected, since its
 * `activeIndex` is always in range whenever `open` is true.
 *
 * Not for: filtering, the active index STATE (only its setter), or what a menu family's rows/matches
 * even are - those stay fully owned by each caller's own hook.
 */
export interface AutocompleteMenuKeysOptions<T> {
  readonly open: boolean;
  readonly matches: readonly T[];
  readonly activeIndex: number;
  readonly setActiveIndex: (updater: SetStateAction<number>) => void;
  /** Tab or (non-shift) Enter on the highlighted match. The event is passed through so a caller can
   *  branch on `event.key` (e.g. the slash menu's Enter-on-exact-match falls through to form submit
   *  instead of re-accepting an already-typed command; Tab never takes that branch). */
  readonly onAccept: (match: T, event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /** Escape on an open menu. Never fires for a closed menu (the caller's own dismiss bookkeeping, e.g.
   *  a per-token "dismissed for" key, decides what "open" means afterward). */
  readonly onEscape: () => void;
}

/** Returns the composer's `onMenuKeyDown` for one autocomplete menu: true when the event was consumed. */
export function useAutocompleteMenuKeys<T>({
  open,
  matches,
  activeIndex,
  setActiveIndex,
  onAccept,
  onEscape,
}: AutocompleteMenuKeysOptions<T>): (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean {
  return useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (!open) {
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return true;
      }
      const selected = matches[activeIndex];
      if (!selected) {
        // An open-but-empty menu owns nothing else: Backspace/typing edit the query, Enter submits.
        return false;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % matches.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
        return true;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        onAccept(selected, event);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        onAccept(selected, event);
        return true;
      }
      return false;
    },
    [open, matches, activeIndex, setActiveIndex, onAccept, onEscape],
  );
}
