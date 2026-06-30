import { asMaybeString, asOptRecord } from "./coerce";

/**
 * The host-owned nested command-menu contract (plan 03, M1). A command family describes hierarchical
 * choices - parent rows, child rows, action ids, disabled reasons, search - as a structured payload
 * carried on a `command.result`. The web renders ANY such payload with one generic component, so a new
 * command family (the first is `/style`) needs no bespoke web code. Pure types + a permissive decoder +
 * the small selection/search helpers the host and web share, so the contract has one owner and the two
 * surfaces can never disagree on what a row "means".
 *
 * v1 is intentionally narrow (escape hatch 1): at most TWO levels - a row is either a leaf action or a
 * submenu whose `children` are leaf actions. Breadcrumbs are derived from navigation, not stored.
 */

/** One row in a nested command menu: a leaf action to run, or a submenu (when it has `children`). */
export interface CommandMenuRow {
  /** Stable id: the action token the host dispatches on, or the submenu key. Unique within its level. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Present => the row is rendered disabled and not selectable, with this reason surfaced. */
  readonly disabledReason?: string;
  /** Present + true => the row is the current selection (e.g. the active style), shown as marked. */
  readonly selected?: boolean;
  /** A short marker chip, e.g. "default" or "active". */
  readonly badge?: string;
  /** Present + non-empty => this row is a SUBMENU: selecting it navigates to these leaf rows. */
  readonly children?: readonly CommandMenuRow[];
}

/** A nested command menu for one command family, carried on a command result. */
export interface CommandMenuPayload {
  /** The command-family id, e.g. "style" - dispatched back as `/<family> <action-id>`. */
  readonly family: string;
  /** The menu header, e.g. "Output style". */
  readonly title: string;
  readonly rows: readonly CommandMenuRow[];
  /** Whether the renderer shows a search box (for long lists). */
  readonly searchable?: boolean;
  /** Shown when the menu (or the filtered view) has no rows. */
  readonly emptyText?: string;
}

/** A row is actionable when it is neither disabled nor a submenu (a submenu navigates, it does not act). */
export function isSubmenu(row: CommandMenuRow): boolean {
  return Array.isArray(row.children) && row.children.length > 0;
}

/** Whether selecting `row` runs an action (vs navigating into a submenu or being inert because disabled). */
export function isActionable(row: CommandMenuRow): boolean {
  return !row.disabledReason && !isSubmenu(row);
}

/** Case-insensitive filter over label + description. A submenu row is kept when it OR any child matches,
 *  so searching a parent surfaces its matching children. Pure - the web and tests share it. */
export function filterMenuRows(
  rows: readonly CommandMenuRow[],
  query: string,
): readonly CommandMenuRow[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return rows;
  }
  const matches = (row: CommandMenuRow): boolean =>
    row.label.toLowerCase().includes(q) ||
    (row.description?.toLowerCase().includes(q) ?? false) ||
    (row.children?.some(matches) ?? false);
  return rows.filter(matches);
}

/** Finds a row by id at the top level, then within each submenu's children (the dispatch lookup). */
export function findMenuRow(rows: readonly CommandMenuRow[], id: string): CommandMenuRow | null {
  for (const row of rows) {
    if (row.id === id) {
      return row;
    }
    const child = row.children?.find((c) => c.id === id);
    if (child) {
      return child;
    }
  }
  return null;
}

/** Permissively decodes one row from untrusted JSON; returns null when it lacks an id/label (dropped). */
export function decodeCommandMenuRow(v: unknown): CommandMenuRow | null {
  const o = asOptRecord(v);
  if (!o || typeof o.id !== "string" || typeof o.label !== "string") {
    return null;
  }
  const children = Array.isArray(o.children)
    ? o.children.map(decodeCommandMenuRow).filter((r): r is CommandMenuRow => r !== null)
    : [];
  const description = asMaybeString(o.description);
  const disabledReason = asMaybeString(o.disabledReason);
  const badge = asMaybeString(o.badge);
  return {
    id: o.id,
    label: o.label,
    ...(description !== undefined ? { description } : {}),
    ...(disabledReason !== undefined ? { disabledReason } : {}),
    ...(o.selected === true ? { selected: true } : {}),
    ...(badge !== undefined ? { badge } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

/** Permissively decodes a menu payload, or null when the core fields (family/title/rows) are missing -
 *  so a `command.result` without a (valid) menu just renders its text, backward-compatibly. */
export function decodeCommandMenu(v: unknown): CommandMenuPayload | null {
  const o = asOptRecord(v);
  if (!o || typeof o.family !== "string" || typeof o.title !== "string" || !Array.isArray(o.rows)) {
    return null;
  }
  const rows = o.rows.map(decodeCommandMenuRow).filter((r): r is CommandMenuRow => r !== null);
  const emptyText = asMaybeString(o.emptyText);
  return {
    family: o.family,
    title: o.title,
    rows,
    ...(o.searchable === true ? { searchable: true } : {}),
    ...(emptyText !== undefined ? { emptyText } : {}),
  };
}
