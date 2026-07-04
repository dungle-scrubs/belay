import type { CommandSpec } from "@trevor/session";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAutocompleteMenuKeys } from "./use-autocomplete-menu-keys";

export interface SlashMenu {
  readonly menuOpen: boolean;
  readonly menuMatches: readonly CommandSpec[];
  readonly menuIndex: number;
  readonly slashQuery: string | null;
  readonly acceptCommand: (name: string) => void;
  readonly onMenuKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
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
  };
}
