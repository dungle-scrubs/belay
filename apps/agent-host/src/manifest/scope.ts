import type { ManifestItem, ManifestScope, SectionBody, SectionProvenance } from "@trevor/session";

/**
 * Scope policy shared by every manifest section adapter (plan 14, M3). The manifest scope decides how
 * much a reader sees: the `human`/`client` views are the FULL debug/UI surface (hidden, debug, and
 * non-available capabilities are shown, tagged by scope), while the prompt-facing `compact`/`subagent`/
 * `expert` views drop those and cap counts to protect the token budget. Centralizing the policy keeps
 * every section consistent - a capability is never visible in one section's compact view but hidden in
 * another's.
 */

/** The full-fidelity scopes that surface hidden/debug/non-available capabilities (tagged, not dropped). */
export function scopeShowsHidden(scope: ManifestScope): boolean {
  return scope === "human" || scope === "client";
}

/** Per-section item cap for a scope. Full scopes get a generous cap; prompt scopes stay tight. */
export function scopeItemCap(scope: ManifestScope): number {
  return scopeShowsHidden(scope) ? 200 : 25;
}

/**
 * Builds a {@link SectionBody} from descriptive items: caps to `cap` (recording `total` + a `detail`
 * pointer when it truncates), reports an explicit `empty` status for a zero-item section, and stamps
 * provenance. The one place a core section turns items into a bounded body, so capping/empty/provenance
 * stay identical across sections.
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
