import type { ManifestItem, SectionBody, SectionProvenance } from "@trevor/session";

/**
 * Shared section-body helpers (plan 14, M4 REFACTOR). Every section adapter - core (M3) and dynamic (M4) -
 * turns its items into a {@link SectionBody} through ONE of these, so capping, the empty/unavailable
 * status, freshness, and provenance are computed identically everywhere. A section can never invent its own
 * truncation shape or forget provenance.
 *
 * Responsible for: the shared SectionBody builders - elide previews, freshness checks, and
 * capped/empty/unavailable bodies with provenance.
 * Not for: the scope policy (caps per scope, hidden visibility) - see scope.ts.
 */

/** Freshness input in the shape the catalog/source registries expose (`refreshedAt` + `stale`). */
export interface FreshnessLike {
  readonly refreshedAt: string | null;
  readonly stale: boolean;
}

/** Joins `values` into a preview string, showing the first `cap` and eliding the rest as "+N more". Empty
 *  input yields "". The one place the "first N, then +K more" shape lives, shared by every section. */
export function elide(values: readonly string[], cap: number): string {
  const shown = values.slice(0, cap);
  return values.length > cap
    ? `${shown.join(", ")}, +${values.length - cap} more`
    : shown.join(", ");
}

/** Whether a freshness record counts as current: refreshed at least once and not marked stale. */
export function isFresh(freshness: FreshnessLike): boolean {
  return freshness.refreshedAt !== null && !freshness.stale;
}

/**
 * Builds a {@link SectionBody} from descriptive items: caps to `cap` (recording `total` + a `detail`
 * pointer when it truncates), reports an explicit `empty` status for a zero-item section, and stamps
 * provenance. The one place a section turns items into a bounded body.
 */
export function sectionBody(args: {
  readonly items: readonly ManifestItem[];
  readonly cap: number;
  readonly source: string;
  readonly detail?: string;
  readonly emptyNote?: string;
  readonly fresh?: boolean;
}): SectionBody {
  const provenance: SectionProvenance = {
    source: args.source,
    ...(args.fresh !== undefined ? { fresh: args.fresh } : {}),
  };
  if (args.items.length === 0) {
    return {
      status: "empty",
      items: [],
      provenance,
      ...(args.emptyNote ? { note: args.emptyNote } : {}),
    };
  }
  if (args.items.length > args.cap) {
    return {
      status: "truncated",
      items: args.items.slice(0, args.cap),
      total: args.items.length,
      provenance,
      ...(args.detail ? { detail: args.detail } : {}),
    };
  }
  return { status: "ok", items: args.items, provenance };
}

/**
 * An explicit `unavailable` body: a subsystem with no live backend (an MCP/LSP/hooks runtime not yet wired)
 * reports this - a visible row with a sanitized reason, never a silently missing section.
 */
export function unavailableBody(source: string, note: string): SectionBody {
  return { status: "unavailable", items: [], note, provenance: { source } };
}
