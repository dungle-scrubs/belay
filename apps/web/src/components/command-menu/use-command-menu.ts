import {
  type CommandMenuPayload,
  type CommandMenuRow,
  filterMenuRows,
  isSubmenu,
} from "@trevor/session";
import { useMemo, useState } from "react";
import { arrowNavIndex } from "@/hooks/use-autocomplete-menu-keys";

/**
 * The navigation, search, and keyboard state for the generic nested command menu (plan 03, M2). Pure
 * over the host-owned {@link CommandMenuPayload} - it owns NO command-specific knowledge, so `/style`
 * and any future family share it. Two-level v1: the root rows, or one submenu's children. Selecting an
 * action dispatches `(family, actionId)` back through the command path (never a model turn); selecting a
 * submenu navigates; a disabled row is inert.
 */

export interface CommandMenuView {
  /** The current header: the menu title at the root, or the open submenu's label. */
  readonly title: string;
  /** The trail from the root title to the current level (one or two entries in v1). */
  readonly breadcrumb: readonly string[];
  /** The rows to render at the current level, after the search filter. */
  readonly rows: readonly CommandMenuRow[];
  /** The keyboard-highlighted row index (into {@link rows}). */
  readonly highlighted: number;
  readonly query: string;
  readonly searchable: boolean;
  /** True inside a submenu (a back affordance is shown). */
  readonly canGoBack: boolean;
  readonly emptyText: string;
  setQuery(query: string): void;
  setHighlighted(index: number): void;
  /** Back out of a submenu to the root, or close the menu when already at the root. */
  back(): void;
  /** Activate a row: navigate into a submenu, dispatch an action, or no-op when disabled. */
  activate(row: CommandMenuRow): void;
  /** Container/search keydown handler; returns true when it handled the key. */
  onKeyDown(event: { readonly key: string; preventDefault(): void }): boolean;
}

export interface UseCommandMenuOptions {
  /** Dispatch a chosen leaf action back to the host (the command path), e.g. `/style concise`. */
  readonly onAction: (family: string, actionId: string) => void;
  /** Called when `back()` is invoked at the root level (close the menu). Optional. */
  readonly onClose?: () => void;
  /** Open this submenu initially (deep-link / Storybook); defaults to the root level. */
  readonly defaultOpenId?: string;
}

export function useCommandMenu(
  payload: CommandMenuPayload,
  options: UseCommandMenuOptions,
): CommandMenuView {
  const [openId, setOpenId] = useState<string | null>(options.defaultOpenId ?? null);
  const [query, setQueryRaw] = useState("");
  const [highlighted, setHighlighted] = useState(0);

  const parent = openId
    ? (payload.rows.find((r) => r.id === openId && isSubmenu(r)) ?? null)
    : null;
  const levelRows = parent?.children ?? payload.rows;
  const rows = useMemo(() => filterMenuRows(levelRows, query), [levelRows, query]);

  const setQuery = (next: string): void => {
    setQueryRaw(next);
    setHighlighted(0);
  };

  const back = (): void => {
    if (parent) {
      setOpenId(null);
      setQueryRaw("");
      setHighlighted(0);
    } else {
      options.onClose?.();
    }
  };

  const activate = (row: CommandMenuRow): void => {
    if (row.disabledReason) {
      return;
    }
    if (isSubmenu(row)) {
      setOpenId(row.id);
      setQueryRaw("");
      setHighlighted(0);
      return;
    }
    options.onAction(payload.family, row.id);
  };

  const onKeyDown = (event: { readonly key: string; preventDefault(): void }): boolean => {
    // Arrow up/down share the cycle-vs-clamp arithmetic with the composer autocomplete menus; this menu
    // CLAMPS (a nested menu has a back affordance, so wrapping past the top would fight ArrowLeft/Escape).
    const arrowMove = (i: number) => arrowNavIndex(event.key, i, rows.length, { wrap: false });
    if (arrowMove(highlighted) !== null) {
      event.preventDefault();
      setHighlighted((i) => arrowMove(i) ?? i);
      return true;
    }
    switch (event.key) {
      case "Enter": {
        const row = rows[highlighted];
        if (row) {
          event.preventDefault();
          activate(row);
        }
        return true;
      }
      case "Escape":
        event.preventDefault();
        back();
        return true;
      case "ArrowLeft":
        if (parent) {
          event.preventDefault();
          back();
          return true;
        }
        return false;
      default:
        return false;
    }
  };

  return {
    title: parent ? parent.label : payload.title,
    breadcrumb: parent ? [payload.title, parent.label] : [payload.title],
    rows,
    highlighted,
    query,
    searchable: payload.searchable ?? false,
    canGoBack: parent !== null,
    emptyText: payload.emptyText ?? "No matches.",
    setQuery,
    setHighlighted,
    back,
    activate,
    onKeyDown,
  };
}
