import { basename } from "node:path";
import {
  type CatalogEntry,
  type DoctorArea,
  MANIFEST_VERSION,
  type ManifestItem,
  type ManifestMetaValue,
  type ManifestSectionId,
  type SectionProvider,
} from "@belay/session";
import type { CatalogSnapshot } from "../providers/catalog";
import { scopeItemCap } from "./scope";
import { elide, isFresh, sectionBody, unavailableBody } from "./section-helpers";

/**
 * The dynamic runtime + integration section adapters (plan 14, M4): MCP / LSP / hooks / docs, the Doctor
 * area roll-up, the provider/source/catalog summary, and the runtime / protocol / workspace facts. These
 * cover the LARGE or CHANGING surfaces, so the golden rule here is: summarize, never inline. A source with
 * a thousand models becomes one row with a count + aggregated quant/arch/capability facts (D-005), not a
 * thousand rows; a subsystem with no live backend (MCP/LSP/hooks until plans 23-25 land) becomes one
 * explicit `unavailable` row, never a silently missing section.
 *
 * Like the core adapters (M3) these are pure over already-read data and share the section-body helpers, so
 * capping/freshness/provenance stay uniform.
 *
 * Responsible for: the dynamic section adapters - peripherals (MCP/LSP/hooks/docs), the doctor
 * roll-up, the catalog summary, and the runtime/protocol/workspace facts.
 * Not for: static registry sections (tools/commands/skills/...) - see core-sections.ts.
 */

/** How many distinct aggregated values (capabilities, quant labels, archs) to join before eliding. */
const AGGREGATE_PREVIEW = 6;

/** A peripheral runtime's state: not yet configured (no backend), or ready with summarized items. */
export type PeripheralState =
  | { readonly kind: "unconfigured"; readonly note?: string }
  | { readonly kind: "ready"; readonly items: readonly ManifestItem[]; readonly detail?: string };

/**
 * A generic adapter for a peripheral runtime (MCP servers, LSP servers, hooks, docs corpora). Until its
 * runtime lands it reports `unavailable` with a note; once wired, it summarizes the configured items with
 * the shared cap. One factory serves every peripheral so they can never disagree on the unavailable shape.
 */
export function peripheralSection(args: {
  readonly id: ManifestSectionId;
  readonly title: string;
  readonly source: string;
  readonly state: PeripheralState;
}): SectionProvider {
  return {
    id: args.id,
    title: args.title,
    provide: (ctx) => {
      if (args.state.kind === "unconfigured") {
        return unavailableBody(args.source, args.state.note ?? `${args.title} not configured`);
      }
      return sectionBody({
        items: args.state.items,
        cap: scopeItemCap(ctx.scope),
        source: args.source,
        emptyNote: `no ${args.title.toLowerCase()}`,
        ...(args.state.detail ? { detail: args.state.detail } : {}),
        fresh: true,
      });
    },
  };
}

/** The Doctor snapshot's areas, summarized to id + status + one-line verdict (never the findings). */
export function doctorSection(input: {
  readonly areas: readonly Pick<DoctorArea, "id" | "label" | "status" | "verdict">[];
}): SectionProvider {
  return {
    id: "doctor",
    title: "Doctor",
    provide: (ctx) => {
      const items: ManifestItem[] = input.areas.map((area) => ({
        id: area.id,
        label: area.label,
        summary: area.verdict,
        meta: { status: area.status },
      }));
      return sectionBody({
        items,
        cap: scopeItemCap(ctx.scope),
        source: "doctor-snapshot",
        detail: "doctor",
        emptyNote: "doctor not run",
        fresh: true,
      });
    },
  };
}

/** Distinct + sorted + bounded preview of a set of values ("a, b, +N more"), or undefined if empty. */
function aggregate(values: Iterable<string>): string | undefined {
  const distinct = [...new Set([...values].filter((v) => v.length > 0))].sort();
  return distinct.length === 0 ? undefined : elide(distinct, AGGREGATE_PREVIEW);
}

/**
 * The provider/source/catalog summary (D-005). One item per SOURCE - id, status, model count - plus, for
 * local sources, aggregated quantization / architecture / capability facts drawn from the live
 * {@link CatalogEntry} rows. The individual models are NEVER inlined (a source can hold hundreds); the
 * aggregates + count describe the catalog, and the model chooser / `/doctor` remain the per-model read.
 */
export function catalogSection(input: { readonly snapshot: CatalogSnapshot }): SectionProvider {
  return {
    id: "catalog",
    title: "Model catalog",
    provide: (ctx) => {
      const items: ManifestItem[] = input.snapshot.sources.map((source) => {
        const entries: readonly CatalogEntry[] =
          input.snapshot.catalogBySource[source.sourceId] ?? [];
        const caps = aggregate(entries.flatMap((e) => e.capabilities));
        const quant = aggregate(
          entries.map((e) => e.quantization).filter((q): q is string => q !== undefined),
        );
        const arch = aggregate(
          entries.map((e) => e.arch).filter((a): a is string => a !== undefined),
        );
        const meta: Record<string, ManifestMetaValue> = {
          models: source.modelCount,
          type: source.type,
          status: source.status,
          stale: source.freshness.stale,
        };
        if (caps) {
          meta.caps = caps;
        }
        if (quant) {
          meta.quant = quant;
        }
        if (arch) {
          meta.arch = arch;
        }
        return { id: source.sourceId, label: source.label, summary: source.status, meta };
      });
      // A source's freshness is per-source; the section is "fresh" when every source is current.
      const fresh = input.snapshot.sources.every((s) => isFresh(s.freshness));
      return sectionBody({
        items,
        cap: scopeItemCap(ctx.scope),
        source: "catalog-snapshot",
        detail: "doctor",
        emptyNote: "no model sources",
        fresh,
      });
    },
  };
}

/** Live host runtime facts: role (leader/follower), instance id, current turn state, uptime when known. */
export function runtimeSection(input: {
  readonly role: string;
  readonly instanceId: string;
  readonly turn?: string;
  readonly uptimeMs?: number;
}): SectionProvider {
  return {
    id: "runtime",
    title: "Runtime",
    provide: (ctx) => {
      const items: ManifestItem[] = [
        { id: "role", label: "Role", summary: input.role },
        { id: "instance", label: "Instance", summary: input.instanceId },
        ...(input.turn ? [{ id: "turn", label: "Turn", summary: input.turn }] : []),
        ...(input.uptimeMs !== undefined
          ? [
              {
                id: "uptime",
                label: "Uptime",
                meta: { seconds: Math.round(input.uptimeMs / 1000) },
              } satisfies ManifestItem,
            ]
          : []),
      ];
      return sectionBody({
        items,
        cap: scopeItemCap(ctx.scope),
        source: "host-runtime",
        fresh: true,
      });
    },
  };
}

/** Protocol/version facts: the manifest schema version and the host build/version when known. */
export function protocolSection(input: {
  readonly hostVersion?: string;
  readonly hostBuild?: string;
}): SectionProvider {
  return {
    id: "protocol",
    title: "Protocol",
    provide: (ctx) => {
      const items: ManifestItem[] = [
        { id: "manifest", label: "Manifest schema", meta: { version: MANIFEST_VERSION } },
        ...(input.hostVersion || input.hostBuild
          ? [
              {
                id: "host",
                label: "Host",
                ...(input.hostVersion ? { summary: input.hostVersion } : {}),
                ...(input.hostBuild ? { meta: { build: input.hostBuild } } : {}),
              } satisfies ManifestItem,
            ]
          : []),
      ];
      return sectionBody({ items, cap: scopeItemCap(ctx.scope), source: "protocol", fresh: true });
    },
  };
}

/** Workspace facts: the project basename + branch. Never the absolute home path - only collapsed labels. */
export function workspaceSection(input: {
  readonly root: string;
  readonly cwd: string;
  readonly branch?: string;
}): SectionProvider {
  return {
    id: "workspace",
    title: "Workspace",
    provide: (ctx) => {
      const rootName = basename(input.root);
      const cwdName = basename(input.cwd);
      const items: ManifestItem[] = [
        { id: "root", label: "Project", summary: rootName },
        // Only surface cwd when it differs from the project root (a subdirectory), still as a basename.
        ...(cwdName && cwdName !== rootName
          ? [{ id: "cwd", label: "Directory", summary: cwdName } satisfies ManifestItem]
          : []),
        ...(input.branch ? [{ id: "branch", label: "Branch", summary: input.branch }] : []),
      ];
      return sectionBody({ items, cap: scopeItemCap(ctx.scope), source: "workspace", fresh: true });
    },
  };
}
