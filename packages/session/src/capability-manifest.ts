import { asMaybeString, asOptRecord, oneOf } from "./coerce";

/**
 * The host-owned CAPABILITY MANIFEST contract (plan 14, M1). The manifest answers "what can this Belay
 * host do?" as structured, versioned data derived from live registries - never handwritten prose. One
 * schema serves every consumer (humans, clients, subagents, exports, the built-in `belay-expert`); the
 * {@link ManifestScope} controls density and which capabilities are visible, so "full" and "compact" are
 * the SAME shape at different scopes/caps, not two divergent schemas. That single-source design is what
 * keeps the compact prompt view from drifting away from the full human view (plan 14 M5).
 *
 * This module is pure types + constants + a permissive decoder + small deterministic helpers. It owns the
 * contract so the host builder (which reads registries) and every reader agree on what a section "means".
 *
 * A manifest DESCRIBES capability; it never GRANTS it. The decoder is the choke point that enforces this:
 * it copies only known descriptive fields and coerces `meta` to primitives, so an item can never smuggle a
 * `run`/`handler`/token or a nested authority object through the contract (D-001, the "not a permission
 * system" constraint). Section ids are a CLOSED set - an unknown id is dropped, not surfaced.
 */

/** The manifest schema version. Bump only on an incompatible section/field change. */
export const MANIFEST_VERSION = 1;

/**
 * Who a manifest is generated for. Narrower scopes drop hidden/debug capabilities and cap dynamic
 * sections: `human`/`client` are the full debug/UI views; `compact` is the token-budgeted prompt view;
 * `subagent` and `expert` are scoped slices for a spawned agent and the built-in `belay-expert`.
 */
export type ManifestScope = "human" | "client" | "compact" | "subagent" | "expert";

export const MANIFEST_SCOPES: readonly ManifestScope[] = [
  "human",
  "client",
  "compact",
  "subagent",
  "expert",
];

/**
 * The CLOSED set of manifest section ids, in canonical composition/export order. A section adapter owns one
 * id; a reader keys off it. New capability surfaces are added here (and given an adapter), never invented
 * ad hoc by a provider - so the id space stays stable and enumerable.
 */
export type ManifestSectionId =
  | "tools"
  | "commands"
  | "commandFamilies"
  | "styles"
  | "skills"
  | "agents"
  | "mcp"
  | "lsp"
  | "hooks"
  | "docs"
  | "doctor"
  | "catalog"
  | "runtime"
  | "protocol"
  | "workspace";

export const MANIFEST_SECTION_ORDER: readonly ManifestSectionId[] = [
  "tools",
  "commands",
  "commandFamilies",
  "styles",
  "skills",
  "agents",
  "mcp",
  "lsp",
  "hooks",
  "docs",
  "doctor",
  "catalog",
  "runtime",
  "protocol",
  "workspace",
];

/**
 * A section's availability. `unavailable` (no backend / not configured) and `error` (the adapter failed)
 * are represented EXPLICITLY with a sanitized note, so a missing surface is visible, never silently
 * dropped. `truncated` means the section was capped and `detail` points at how to fetch the rest.
 */
export type SectionStatus = "ok" | "empty" | "unavailable" | "truncated" | "error";

const SECTION_STATUSES: readonly SectionStatus[] = [
  "ok",
  "empty",
  "unavailable",
  "truncated",
  "error",
];

/** A primitive descriptive value - the only thing a manifest item may carry beyond text. */
export type ManifestMetaValue = string | number | boolean;

/**
 * One capability entry. Purely descriptive: an id, a label, an optional summary, an optional descriptive
 * `scope`/visibility TAG (e.g. "debug", "hidden" - a label, not an access grant), and bounded `meta`
 * facts (counts, status, quantization). No field carries executable authority or secret material.
 */
export interface ManifestItem {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  /** A descriptive visibility/scope tag (NOT a permission): "default", "debug", "hidden", "readonly", … */
  readonly scope?: string;
  /** Bounded primitive facts about the item (counts, status, quant/arch). Never nested, never secrets. */
  readonly meta?: Readonly<Record<string, ManifestMetaValue>>;
}

/** Where a section's data came from + whether it is current, so a reader can judge staleness. */
export interface SectionProvenance {
  /** The source-of-truth registry, e.g. "command-registry", "skill-registry", "catalog-snapshot". */
  readonly source: string;
  /** Whether the underlying read is current (false => a cached/stale snapshot). */
  readonly fresh?: boolean;
}

/** One composed manifest section: a bounded, ordered list of descriptive items with an explicit status. */
export interface ManifestSection {
  readonly id: ManifestSectionId;
  readonly title: string;
  readonly status: SectionStatus;
  /** Sanitized reason, for `unavailable`/`error`/`empty` (no secrets, no absolute paths). */
  readonly note?: string;
  readonly items: readonly ManifestItem[];
  /** Total entries available before capping (present when `status` is `truncated`). */
  readonly total?: number;
  /** The tool/command name that fetches detail beyond the cap - a pointer, never an inline dump. */
  readonly detail?: string;
  readonly provenance?: SectionProvenance;
}

/** Host build/version facts, when known. */
export interface ManifestHostInfo {
  readonly version?: string;
  readonly build?: string;
  readonly protocol?: number;
}

/** Workspace facts relevant to the reader; a collapsed label, never an absolute home path. */
export interface ManifestWorkspace {
  readonly root?: string;
}

/**
 * The full capability manifest. A `compact` manifest is the SAME type at a prompt scope (`compact`/
 * `subagent`/`expert`) with capped sections, so section ids stay stable across the full and compact forms.
 */
export interface CapabilityManifest {
  readonly version: number;
  readonly scope: ManifestScope;
  /** ISO-8601 generation time (the builder injects a clock; the contract stays pure). */
  readonly generatedAt: string;
  readonly host?: ManifestHostInfo;
  readonly workspace?: ManifestWorkspace;
  readonly sections: readonly ManifestSection[];
  /** True when any section was capped/truncated. */
  readonly truncated: boolean;
}

const SECTION_ID_SET: ReadonlySet<string> = new Set(MANIFEST_SECTION_ORDER);
const SECTION_ORDER_INDEX: ReadonlyMap<ManifestSectionId, number> = new Map(
  MANIFEST_SECTION_ORDER.map((id, i) => [id, i]),
);

/** Type guard for the closed section-id set. */
export function isManifestSectionId(v: unknown): v is ManifestSectionId {
  return typeof v === "string" && SECTION_ID_SET.has(v);
}

/** Sorts sections into the canonical {@link MANIFEST_SECTION_ORDER}; stable + deterministic. */
export function orderSections<T extends { readonly id: ManifestSectionId }>(
  sections: readonly T[],
): readonly T[] {
  const index = (id: ManifestSectionId): number =>
    SECTION_ORDER_INDEX.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...sections].sort((a, b) => index(a.id) - index(b.id));
}

/** Whether a set of sections is truncated (any section explicitly `truncated`, or capped below its total). */
export function computeTruncated(sections: readonly ManifestSection[]): boolean {
  return sections.some(
    (s) => s.status === "truncated" || (s.total !== undefined && s.total > s.items.length),
  );
}

/** Keeps only primitive `meta` values (string/number/boolean); drops nested objects, arrays, functions. */
function sanitizeMeta(v: unknown): Readonly<Record<string, ManifestMetaValue>> | undefined {
  const o = asOptRecord(v);
  if (!o) {
    return undefined;
  }
  const out: Record<string, ManifestMetaValue> = {};
  for (const [key, value] of Object.entries(o)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Permissively decodes one item, copying ONLY the descriptive fields (id, label, summary, scope, meta) and
 * dropping everything else. This is the choke point that makes the manifest descriptive-only: a `run`,
 * `handler`, `token`, or nested authority object cannot survive. Returns null when id/label are missing.
 */
export function decodeManifestItem(v: unknown): ManifestItem | null {
  const o = asOptRecord(v);
  if (!o || typeof o.id !== "string" || typeof o.label !== "string") {
    return null;
  }
  const summary = asMaybeString(o.summary);
  const scope = asMaybeString(o.scope);
  const meta = sanitizeMeta(o.meta);
  return {
    id: o.id,
    label: o.label,
    ...(summary !== undefined ? { summary } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

/** Permissively decodes one section, dropping it (returns null) when its id is not in the closed set. */
export function decodeManifestSection(v: unknown): ManifestSection | null {
  const o = asOptRecord(v);
  if (!o || !isManifestSectionId(o.id) || typeof o.title !== "string") {
    return null;
  }
  const status = oneOf(SECTION_STATUSES, o.status, "ok");
  const items = Array.isArray(o.items)
    ? o.items.map(decodeManifestItem).filter((i): i is ManifestItem => i !== null)
    : [];
  const note = asMaybeString(o.note);
  const detail = asMaybeString(o.detail);
  const total = typeof o.total === "number" ? o.total : undefined;
  const provenanceRec = asOptRecord(o.provenance);
  const provenance =
    provenanceRec && typeof provenanceRec.source === "string"
      ? {
          source: provenanceRec.source,
          ...(typeof provenanceRec.fresh === "boolean" ? { fresh: provenanceRec.fresh } : {}),
        }
      : undefined;
  return {
    id: o.id,
    title: o.title,
    status,
    items,
    ...(note !== undefined ? { note } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

/**
 * Permissively decodes a whole manifest from untrusted JSON, or null when the core fields (version, scope,
 * generatedAt, sections[]) are missing. An unknown scope normalizes to `human`; unknown-id sections are
 * dropped; every item is scrubbed to descriptive-only. The single trust boundary for machine-read exports.
 */
export function decodeCapabilityManifest(v: unknown): CapabilityManifest | null {
  const o = asOptRecord(v);
  if (
    !o ||
    typeof o.version !== "number" ||
    typeof o.generatedAt !== "string" ||
    !Array.isArray(o.sections)
  ) {
    return null;
  }
  const scope = oneOf(MANIFEST_SCOPES, o.scope, "human");
  const sections = o.sections
    .map(decodeManifestSection)
    .filter((s): s is ManifestSection => s !== null);
  const hostRec = asOptRecord(o.host);
  const host: ManifestHostInfo | undefined = hostRec
    ? {
        ...(asMaybeString(hostRec.version) !== undefined
          ? { version: asMaybeString(hostRec.version) }
          : {}),
        ...(asMaybeString(hostRec.build) !== undefined
          ? { build: asMaybeString(hostRec.build) }
          : {}),
        ...(typeof hostRec.protocol === "number" ? { protocol: hostRec.protocol } : {}),
      }
    : undefined;
  const workspaceRec = asOptRecord(o.workspace);
  const workspaceRoot = workspaceRec ? asMaybeString(workspaceRec.root) : undefined;
  return {
    version: o.version,
    scope,
    generatedAt: o.generatedAt,
    sections,
    truncated: typeof o.truncated === "boolean" ? o.truncated : computeTruncated(sections),
    ...(host && Object.keys(host).length > 0 ? { host } : {}),
    ...(workspaceRoot !== undefined ? { workspace: { root: workspaceRoot } } : {}),
  };
}
