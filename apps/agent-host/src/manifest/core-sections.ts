import type {
  CommandMenuPayload,
  CommandSpec,
  ManifestItem,
  SectionProvider,
} from "@trevor/session";
import type { AgentDescriptor } from "../agents";
import type { SkillEntry } from "../skills";
import { splitDescription } from "../skills";
import type { OutputStyle } from "../style/styles";
import { scopeItemCap, scopeShowsHidden, sectionBody } from "./scope";

/**
 * The core registry-derived section adapters (plan 14, M3). Each one turns a source-of-truth registry
 * (tool defs, command specs, command-family menus, output styles, the skill registry, agent descriptors)
 * into a manifest {@link SectionProvider}. They are PURE functions of already-read data - the live read
 * happens where the providers are wired (main.ts) - so each adapter unit-tests without booting a host and
 * carries NO duplicated hardcoded capability list (M3 REFACTOR): the registry is the only source.
 *
 * Every adapter honors the shared scope policy (see {@link scopeShowsHidden}): the human/client views show
 * debug + non-available capabilities tagged by scope, the compact/subagent/expert views drop them and cap
 * counts. Sections summarize - counts, status, a `detail` pointer - and never inline bodies, secrets, or
 * on-disk paths.
 */

/** Tool defs as advertised to the model (name + description), plus the read-only classification set. */
export interface ToolsInput {
  readonly defs: readonly { readonly name: string; readonly description: string }[];
  readonly readOnly: ReadonlySet<string>;
}

export function toolsSection(input: ToolsInput): SectionProvider {
  return {
    id: "tools",
    title: "Tools",
    provide: (ctx) => {
      const items: ManifestItem[] = input.defs.map((def) => ({
        id: def.name,
        label: def.name,
        summary: def.description,
        meta: { readOnly: input.readOnly.has(def.name) },
      }));
      return sectionBody({
        items,
        cap: scopeItemCap(ctx.scope),
        source: "tool-registry",
        fresh: true,
      });
    },
  };
}

/** Base (always-announced) command specs plus the debug-gated specs, tagged separately. */
export interface CommandsInput {
  readonly base: readonly CommandSpec[];
  readonly debug: readonly CommandSpec[];
}

export function commandsSection(input: CommandsInput): SectionProvider {
  return {
    id: "commands",
    title: "Commands",
    provide: (ctx) => {
      const base: ManifestItem[] = input.base.map((spec) => ({
        id: spec.name,
        label: spec.name,
        summary: spec.summary,
        ...(spec.usage ? { meta: { usage: spec.usage } } : {}),
      }));
      // Debug commands are a capability of the host, so the full views describe them (tagged `debug`);
      // the prompt-facing scopes drop them so a subagent/expert is never told about dev-only slashes.
      const debug: ManifestItem[] = scopeShowsHidden(ctx.scope)
        ? input.debug.map((spec) => ({
            id: spec.name,
            label: spec.name,
            summary: spec.summary,
            scope: "debug",
          }))
        : [];
      return sectionBody({
        items: [...base, ...debug],
        cap: scopeItemCap(ctx.scope),
        source: "command-registry",
        fresh: true,
      });
    },
  };
}

/** How many top-level menu choice labels to preview in a family's summary before eliding the rest. */
const CHOICE_PREVIEW = 8;

/** The known command-family menus (e.g. `/style`), summarized by row count - never the rows themselves. */
export interface CommandFamiliesInput {
  readonly families: readonly CommandMenuPayload[];
}

export function commandFamiliesSection(input: CommandFamiliesInput): SectionProvider {
  return {
    id: "commandFamilies",
    title: "Command families",
    provide: (ctx) => {
      const items: ManifestItem[] = input.families.map((family) => {
        // Surface the top-level choice LABELS (bounded), so a reader knows what the family offers
        // without the manifest carrying the full row payload (ids, disabled reasons, children).
        const choices = family.rows.map((row) => row.label);
        const shown = choices.slice(0, CHOICE_PREVIEW);
        const summary =
          choices.length > CHOICE_PREVIEW
            ? `${shown.join(", ")}, +${choices.length - CHOICE_PREVIEW} more`
            : shown.join(", ");
        return {
          id: family.family,
          label: family.title,
          ...(summary ? { summary } : {}),
          meta: { rows: family.rows.length, searchable: family.searchable ?? false },
        };
      });
      return sectionBody({
        items,
        cap: scopeItemCap(ctx.scope),
        source: "command-menu",
        emptyNote: "no command families",
        fresh: true,
      });
    },
  };
}

/** The built-in output styles. */
export interface StylesInput {
  readonly styles: readonly OutputStyle[];
}

export function stylesSection(input: StylesInput): SectionProvider {
  return {
    id: "styles",
    title: "Output styles",
    provide: (ctx) => {
      // Only id/label/description + a default flag - the `guidance` body is a turn-threading detail,
      // never a capability description, so it never enters the manifest.
      const items: ManifestItem[] = input.styles.map((style) => ({
        id: style.id,
        label: style.label,
        summary: style.description,
        meta: { default: style.isDefault ?? false },
      }));
      return sectionBody({
        items,
        cap: scopeItemCap(ctx.scope),
        source: "output-styles",
        fresh: true,
      });
    },
  };
}

/** The discovery skill registry entries (D-075). */
export interface SkillsInput {
  readonly entries: readonly SkillEntry[];
}

export function skillsSection(input: SkillsInput): SectionProvider {
  return {
    id: "skills",
    title: "Skills",
    provide: (ctx) => {
      const showHidden = scopeShowsHidden(ctx.scope);
      const items: ManifestItem[] = input.entries
        // The prompt-facing scopes see only usable skills; the full views see all, status-tagged.
        .filter((entry) => showHidden || entry.status === "available")
        .map((entry) => ({
          id: entry.id,
          label: entry.name,
          // The blurb only - never the on-disk path, and never the Triggers tail as prose.
          summary: splitDescription(entry.description).blurb,
          // A non-available status is a descriptive visibility tag, not an access grant.
          ...(entry.status === "available" ? {} : { scope: entry.status }),
          meta: { status: entry.status, rootKind: entry.rootKind },
        }));
      return sectionBody({
        items,
        cap: scopeItemCap(ctx.scope),
        source: "skill-registry",
        detail: "skills_list",
        emptyNote: "no skills discovered",
        fresh: true,
      });
    },
  };
}

/** The discovered subagent descriptors (id/description + resolved allow-list lengths). */
export interface AgentsInput {
  readonly agents: readonly AgentDescriptor[];
}

export function agentsSection(input: AgentsInput): SectionProvider {
  return {
    id: "agents",
    title: "Agents",
    provide: (ctx) => {
      const items: ManifestItem[] = input.agents.map((agent) => ({
        id: agent.id,
        label: agent.id,
        summary: agent.description,
        // Counts, not the allow-lists themselves - the manifest describes reach, it never grants it.
        meta: { tools: agent.tools.length, skills: agent.skills.length },
      }));
      return sectionBody({
        items,
        cap: scopeItemCap(ctx.scope),
        source: "agent-registry",
        emptyNote: "no agents discovered",
        fresh: true,
      });
    },
  };
}
