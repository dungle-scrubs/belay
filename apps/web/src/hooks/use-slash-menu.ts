import type { CommandSpec } from "@trevor/session";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type CommandArgPreview, commandArgPreview } from "@/derive";
import { useAutocompleteMenuKeys } from "./use-autocomplete-menu-keys";

export interface SlashMenu {
  readonly menuOpen: boolean;
  readonly menuMatches: readonly CommandSpec[];
  readonly menuIndex: number;
  readonly slashQuery: string | null;
  readonly acceptCommand: (name: string) => void;
  readonly onMenuKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  /**
   * The live substitution preview for a file-loaded custom command (plan 44.5 M6), or null. The MENU
   * itself closes once a space is typed (`slashQuery` guards on `!draft.includes(" ")`); the preview is
   * its complement - it fires PAST the first space (`/fix ‹args›`) for a command whose spec carries a
   * body, so the composer can show the resolved prompt while the args are being typed.
   */
  readonly preview: CommandArgPreview | null;
}

export function useSlashMenu({
  draft,
  commandSpecs,
  inputRef,
  setDraft,
}: {
  readonly draft: string;
  readonly commandSpecs: readonly CommandSpec[];
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly setDraft: (draft: string) => void;
}): SlashMenu {
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissedFor, setMenuDismissedFor] = useState<string | null>(null);
  const slashQuery = draft.startsWith("/") && !draft.includes(" ") ? draft : null;
  const menuMatches = useMemo(
    () => (slashQuery ? commandSpecs.filter((c) => c.name.startsWith(slashQuery)) : []),
    [slashQuery, commandSpecs],
  );
  const menuOpen = menuMatches.length > 0 && slashQuery !== null && draft !== menuDismissedFor;
  const boundedMenuIndex = Math.min(menuIndex, menuMatches.length - 1);
  // The live substitution preview lives PAST the first space, exactly where the menu closes (the
  // `!draft.includes(" ")` guard above) - so the two never overlap: menu while choosing, preview while
  // filling args. Computed from the same announced specs the menu filters (they carry the command body).
  const preview = useMemo(() => commandArgPreview(draft, commandSpecs), [draft, commandSpecs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset highlight when the filter changes.
  useEffect(() => setMenuIndex(0), [slashQuery]);

  const acceptCommand = useCallback(
    (name: string) => {
      setDraft(`${name} `);
      inputRef.current?.focus();
    },
    [inputRef, setDraft],
  );

  // Tab always accepts the highlighted command; Enter does too, UNLESS it is already an exact match
  // for the typed draft, in which case Enter falls through to a plain submit instead of re-accepting
  // an already-complete command. `event.key` distinguishes the two (Tab never takes this branch).
  const onAccept = useCallback(
    (spec: CommandSpec, event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && spec.name === draft) {
        event.currentTarget.form?.requestSubmit();
      } else {
        acceptCommand(spec.name);
      }
    },
    [acceptCommand, draft],
  );
  const onEscape = useCallback(() => setMenuDismissedFor(draft), [draft]);
  const onMenuKeyDown = useAutocompleteMenuKeys({
    open: menuOpen,
    matches: menuMatches,
    activeIndex: boundedMenuIndex,
    setActiveIndex: setMenuIndex,
    onAccept,
    onEscape,
  });

  return {
    menuOpen,
    menuMatches,
    menuIndex: boundedMenuIndex,
    slashQuery,
    acceptCommand,
    onMenuKeyDown,
    preview,
  };
}
