import { type FileMatch, fileMentionText } from "@belay/session";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { activeMention } from "@/composer/active-mention";
import { useAutocompleteMenuKeys } from "./use-autocomplete-menu-keys";

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
  // The menu opens UPWARD over the composer, so the LAST row sits closest to the input. Present the
  // matches WORST-FIRST (fuzzy at the top, best at the bottom): the best match lands next to the
  // composer where arrow-down starts, and the default highlight (below) selects it. `searchWorkspaceFiles`
  // ranks best-first; this reversal is presentation-only, so the host's file-search tool keeps its
  // best-first ordering.
  const matches = useMemo(() => (mention ? [...results].reverse() : []), [mention, results]);
  // A per-token dismiss key: Escape stays dismissed for this exact `@…` span, but re-opens once the
  // token text or position changes (more typing, a new token).
  const dismissKey = mention ? `${mention.start}:${draft.slice(mention.start, mention.end)}` : null;
  const menuOpen = mention !== null && dismissKey !== dismissedFor;
  const last = matches.length - 1;
  const lastRef = useRef(last);
  lastRef.current = last;
  const boundedMenuIndex = Math.min(menuIndex, Math.max(0, last));

  // Reset the highlight to the LAST row (the best match, at the bottom near the composer) whenever the
  // query changes. `last` is read through a ref so `query` stays the sole reset trigger (a query that
  // narrows without changing the match count still re-selects the best match); the ref always holds the
  // latest count by the time the post-render effect fires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the intentional reset trigger.
  useEffect(() => setMenuIndex(lastRef.current), [query]);

  const acceptFile = useCallback(
    (path: string) => {
      if (!mention) {
        return;
      }
      // Insert `@path ` and collapse any whitespace the token already abutted, so a mention dropped
      // before existing text (`see @app here`) reads `see @path here`, never with a double space. The
      // trailing space closes the token (the parked caret sits after whitespace -> the menu closes).
      const rest = draft.slice(mention.end).replace(/^\s+/u, "");
      const insertion = `${fileMentionText(path)} `;
      const next = draft.slice(0, mention.start) + insertion + rest;
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

  // Escape closes ONLY this menu (for the current token); it must not bubble to the window
  // cancel/steer handler - useAutocompleteMenuKeys already swallows it (preventDefault + stopPropagation).
  const onEscape = useCallback(() => setDismissedFor(dismissKey), [dismissKey]);
  const onAccept = useCallback((match: FileMatch) => acceptFile(match.path), [acceptFile]);
  const onMenuKeyDown = useAutocompleteMenuKeys({
    open: menuOpen,
    matches,
    activeIndex: boundedMenuIndex,
    setActiveIndex: setMenuIndex,
    onAccept,
    onEscape,
  });

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
