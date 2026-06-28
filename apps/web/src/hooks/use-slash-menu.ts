import type { CommandSpec } from "@trevor/session";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

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

  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const selected = menuOpen ? menuMatches[boundedMenuIndex] : undefined;
      if (!selected) {
        return false;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuIndex((i) => (i + 1) % menuMatches.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex((i) => (i - 1 + menuMatches.length) % menuMatches.length);
        return true;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        acceptCommand(selected.name);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (selected.name !== draft) {
          acceptCommand(selected.name);
        } else {
          event.currentTarget.form?.requestSubmit();
        }
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenuDismissedFor(draft);
        return true;
      }

      return false;
    },
    [acceptCommand, boundedMenuIndex, draft, menuMatches, menuOpen],
  );

  return {
    menuOpen,
    menuMatches,
    menuIndex: boundedMenuIndex,
    slashQuery,
    acceptCommand,
    onMenuKeyDown,
  };
}
