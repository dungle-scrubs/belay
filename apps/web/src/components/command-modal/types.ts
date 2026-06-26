import type { ReactNode } from "react";

/**
 * The presentation contract for one row in the shared command modal (D-089). Both the
 * resume chooser (D-090) and the worktree switcher (D-091) project their domain objects
 * into this shape via their own adapters, so the modal itself stays domain-agnostic - it
 * only knows labels, metadata, status, and an opaque `id` it hands back on selection.
 */
export interface CommandRow {
  /** Stable action id returned to the consumer when this row is chosen. Must be unique. */
  readonly id: string;
  /** Primary text (session title, branch/worktree name). */
  readonly label: string;
  /** Secondary text shown under the label (cwd, session id, base-repo path). */
  readonly metadata?: string;
  /** Right-aligned status text (host presence, agent count, `↑2 ↓1`, "needs you"). */
  readonly status?: string;
  /** Tone for the status text, mapped to a palette color. */
  readonly statusTone?: RowTone;
  /** Marks the row as the current/active selection (renders a leading marker). */
  readonly current?: boolean;
  /** When set, the row is disabled: visible + announced, skipped by keyboard nav. */
  readonly disabledReason?: string;
  /** Extra search terms beyond label/metadata/status. */
  readonly keywords?: readonly string[];
  /** Optional group heading (base repo, "current project"); ungrouped when absent. */
  readonly group?: string;
  /** Optional custom leading node (overrides the default current-marker dot). */
  readonly marker?: ReactNode;
}

/** Status tones, mapped to palette colors in the modal. */
export type RowTone = "default" | "active" | "attention" | "muted" | "danger" | "success";

/** One footer hint: a key cap (or caps) and what it does. */
export interface FooterHint {
  readonly keys: string;
  readonly label: string;
}

/**
 * Filters rows by a free-text query without mutating the source list. Matching is
 * case-insensitive AND-of-tokens over the row's label, metadata, status, and keywords:
 * every whitespace-delimited token of the query must appear somewhere in that haystack.
 * An empty/whitespace query returns the rows unchanged (same array reference preserved
 * order). Pure - the modal's keyboard/selection behavior is layered on top of this.
 */
export function filterRows(rows: readonly CommandRow[], query: string): readonly CommandRow[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return rows;
  }
  return rows.filter((row) => {
    const haystack = [row.label, row.metadata ?? "", row.status ?? "", ...(row.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Partitions filtered rows into groups by their `group` heading, preserving first-seen
 * order both of the groups and of the rows within each. Rows without a group fall under
 * a single anonymous group (heading `null`), so an entirely ungrouped list renders flat.
 */
export function groupRows(
  rows: readonly CommandRow[],
): readonly { readonly heading: string | null; readonly rows: readonly CommandRow[] }[] {
  const order: (string | null)[] = [];
  const byGroup = new Map<string | null, CommandRow[]>();
  for (const row of rows) {
    const key = row.group ?? null;
    let bucket = byGroup.get(key);
    if (!bucket) {
      bucket = [];
      byGroup.set(key, bucket);
      order.push(key);
    }
    bucket.push(row);
  }
  return order.map((heading) => ({ heading, rows: byGroup.get(heading) ?? [] }));
}

/** The default footer hints (navigate / select / close) when a consumer passes none. */
export const DEFAULT_FOOTER_HINTS: readonly FooterHint[] = [
  { keys: "↑↓", label: "navigate" },
  { keys: "↵", label: "select" },
  { keys: "esc", label: "close" },
];

/** Maps a row tone to its text color class. */
export function toneClass(tone: RowTone | undefined): string {
  switch (tone) {
    case "active":
      return "text-smui-frost-3";
    case "attention":
      return "text-smui-yellow";
    case "danger":
      return "text-smui-red";
    case "success":
      return "text-smui-green";
    case "muted":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}
