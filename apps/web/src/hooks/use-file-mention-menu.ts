import { type FileMatch, fileMentionText } from "@trevor/session";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { activeMention } from "@/composer/active-mention";

/**
 * The `@`-file-mention menu, parallel to {@link useSlashMenu}: it owns ONLY the mention menu state and
 * its key handling. It detects the active `@` token under the caret (pure {@link activeMention}), opens
 * over the caller-supplied `results` (a host search the caller drives from `query`), and on selection
 * replaces the token with a visible `@<path>` mention plus a trailing space (parking the caret after
 * it, which closes the token). Escape dismisses ONLY this menu for the current token - it never
 * cancels a turn or clears the draft. Filesystem search and the durable protocol stay elsewhere.
 */
export interface FileMentionMenu {
  readonly menuOpen: boolean;
  readonly matches: readonly FileMatch[];
  readonly menuIndex: number;
  /** The active token's query body (text after `@`), or null when no mention is active. Drives search. */
  readonly query: string | null;
  readonly truncated: boolean;
  /** Replace the active token with `@path ` and park the caret after it. */
  readonly acceptFile: (path: string) => void;
  readonly onMenuKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useFileMentionMenu({
  draft,
  caret,
  results,
  truncated = false,
  suppressed = false,
  inputRef,
  setDraft,
  setCaret,
}: {
  readonly draft: string;
  readonly caret: number;
  /** Matches for the active {@link FileMentionMenu.query}, supplied by the caller's host search. */
  readonly results: readonly FileMatch[];
  /** True when the host capped the result set (drives the menu's truncation summary). */
  readonly truncated?: boolean;
  /** Suppress the menu even on an active token - e.g. the caret is on a `/loop` line (D-003). */
  readonly suppressed?: boolean;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly setDraft: (draft: string) => void;
  /** Keep the caller's caret in sync when a selection re-parks it, so the menu closes at the new caret. */
  readonly setCaret: (caret: number) => void;
}): FileMentionMenu {
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  const mention = useMemo(
    () => (suppressed ? null : activeMention(draft, caret)),
    [suppressed, draft, caret],
  );
  const query = mention?.query ?? null;
  const matches = mention ? results : [];
  // A per-token dismiss key: Escape stays dismissed for this exact `@…` span, but re-opens once the
  // token text or position changes (more typing, a new token).
  const dismissKey = mention ? `${mention.start}:${draft.slice(mention.start, mention.end)}` : null;
  const menuOpen = mention !== null && dismissKey !== dismissedFor;
  const boundedMenuIndex = Math.min(menuIndex, Math.max(0, matches.length - 1));

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight when the query changes.
  useEffect(() => setMenuIndex(0), [query]);

  const acceptFile = useCallback(
    (path: string) => {
      if (!mention) {
        return;
      }
      const insertion = `${fileMentionText(path)} `;
      const next = draft.slice(0, mention.start) + insertion + draft.slice(mention.end);
      const cursor = mention.start + insertion.length;
      setDraft(next);
      setCaret(cursor);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(cursor, cursor);
        }
      });
    },
    [mention, draft, setDraft, setCaret, inputRef],
  );

  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (!menuOpen) {
        return false;
      }
      // Escape closes ONLY this menu (for the current token); it must not bubble to the window
      // cancel/steer handler, so it is swallowed here.
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedFor(dismissKey);
        return true;
      }
      const selected = matches[boundedMenuIndex];
      if (!selected) {
        // An open-but-empty menu owns nothing else: Backspace/typing edit the query, Enter submits.
        return false;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuIndex((i) => (i + 1) % matches.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
        return true;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        acceptFile(selected.path);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        acceptFile(selected.path);
        return true;
      }
      return false;
    },
    [acceptFile, boundedMenuIndex, dismissKey, matches, menuOpen],
  );

  return {
    menuOpen,
    matches,
    menuIndex: boundedMenuIndex,
    query,
    truncated: truncated && menuOpen,
    acceptFile,
    onMenuKeyDown,
  };
}
