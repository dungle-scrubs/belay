import { basename } from "node:path";
import {
  buildManifest,
  type CapabilityManifest,
  type CommandMenuPayload,
  type CommandSpec,
  type DoctorArea,
  type ManifestScope,
  type SectionProvider,
} from "@belay/session";
import type { OutputStyle } from "@host/prefs/styles";
import type { SkillEntry } from "@host/skills/skills";
import type { AgentDescriptor } from "@host/subagents/discovery";
import type { CatalogSnapshot } from "../providers/catalog";
import {
  agentsSection,
  commandFamiliesSection,
  commandsSection,
  skillsSection,
  stylesSection,
  toolsSection,
} from "./core-sections";
import {
  catalogSection,
  doctorSection,
  type PeripheralState,
  peripheralSection,
  protocolSection,
  runtimeSection,
  workspaceSection,
} from "./runtime-sections";

/**
 * The manifest COMPOSITION ROOT (plan 14, M6). {@link assembleManifest} turns one snapshot of live host
 * inputs ({@link ManifestDeps}) into the full provider set and composes a {@link CapabilityManifest} at a
 * requested scope. It is pure over its deps - main.ts reads the live registries once and hands them here -
 * so the whole capability surface composes in a unit test without booting a host.
 *
 * Responsible for: assembling the full section-provider set and composing a CapabilityManifest
 * from one ManifestDeps snapshot at a requested scope.
 * Not for: what each section contains - the adapters in core-sections / runtime-sections own that.
 */

/** One snapshot of everything the manifest sections read. main.ts assembles this per export. */
export interface ManifestDeps {
  readonly toolDefs: readonly { readonly name: string; readonly description: string }[];
  readonly readOnlyTools: ReadonlySet<string>;
  readonly commands: readonly CommandSpec[];
  readonly debugCommands: readonly CommandSpec[];
  readonly commandFamilies: readonly CommandMenuPayload[];
  readonly styles: readonly OutputStyle[];
  readonly skills: readonly SkillEntry[];
  readonly agents: readonly AgentDescriptor[];
  readonly doctorAreas: readonly Pick<DoctorArea, "id" | "label" | "status" | "verdict">[];
  /** The provider/source/catalog snapshot, or null when it has not loaded (an unavailable catalog). */
  readonly catalog: CatalogSnapshot | null;
  readonly runtime: {
    readonly role: string;
    readonly instanceId: string;
    readonly turn?: string;
    readonly uptimeMs?: number;
  };
  readonly host: { readonly version?: string; readonly build?: string };
  readonly workspace: { readonly root: string; readonly cwd: string; readonly branch?: string };
  /** Peripheral runtimes; each defaults to `unconfigured` until its runtime (plans 23-25) lands. */
  readonly peripherals?: {
    readonly mcp?: PeripheralState;
    readonly lsp?: PeripheralState;
    readonly hooks?: PeripheralState;
    readonly docs?: PeripheralState;
  };
}

function unconfigured(note: string): PeripheralState {
  return { kind: "unconfigured", note };
}

/** Builds the full ordered provider set from a deps snapshot. */
export function manifestProviders(deps: ManifestDeps): readonly SectionProvider[] {
  const peripherals = deps.peripherals ?? {};
  return [
    toolsSection({ defs: deps.toolDefs, readOnly: deps.readOnlyTools }),
    commandsSection({ base: deps.commands, debug: deps.debugCommands }),
    commandFamiliesSection({ families: deps.commandFamilies }),
    stylesSection({ styles: deps.styles }),
    skillsSection({ entries: deps.skills }),
    agentsSection({ agents: deps.agents }),
    peripheralSection({
      id: "mcp",
      title: "MCP servers",
      source: "mcp-runtime",
      state: peripherals.mcp ?? unconfigured("no MCP runtime configured"),
    }),
    peripheralSection({
      id: "lsp",
      title: "LSP servers",
      source: "lsp-runtime",
      state: peripherals.lsp ?? unconfigured("no LSP runtime configured"),
    }),
    peripheralSection({
      id: "hooks",
      title: "Hooks",
      source: "hooks-runtime",
      state: peripherals.hooks ?? unconfigured("no hooks runtime configured"),
    }),
    peripheralSection({
      id: "docs",
      title: "Docs",
      source: "docs-runtime",
      state: peripherals.docs ?? unconfigured("no docs corpus configured"),
    }),
    doctorSection({ areas: deps.doctorAreas }),
    deps.catalog
      ? catalogSection({ snapshot: deps.catalog })
      : peripheralSection({
          id: "catalog",
          title: "Model catalog",
          source: "catalog-snapshot",
          state: unconfigured("catalog not loaded"),
        }),
    runtimeSection(deps.runtime),
    protocolSection({
      ...(deps.host.version !== undefined ? { hostVersion: deps.host.version } : {}),
      ...(deps.host.build !== undefined ? { hostBuild: deps.host.build } : {}),
    }),
    workspaceSection(deps.workspace),
  ];
}

/** Composes a manifest at `scope` from a deps snapshot, stamped with `generatedAt` (injected clock). */
export function assembleManifest(
  deps: ManifestDeps,
  scope: ManifestScope,
  generatedAt: string,
): Promise<CapabilityManifest> {
  return buildManifest(manifestProviders(deps), {
    scope,
    generatedAt,
    host: {
      ...(deps.host.version !== undefined ? { version: deps.host.version } : {}),
      ...(deps.host.build !== undefined ? { build: deps.host.build } : {}),
    },
    // The top-level workspace label is a collapsed basename, never the absolute home path (defense in
    // depth: the export redactor would scrub it too, but the composed manifest is already clean).
    workspace: { root: basename(deps.workspace.root) },
  });
}
