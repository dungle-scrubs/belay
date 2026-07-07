import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter, sortedVisibleEntries, trimStr } from "@host/boot/manifest-discovery";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import type { Command } from "@host/commands/commands";
import { interpolate, type SegmentExecutor } from "@host/commands/interpolation-engine";
import { ToolInputError } from "@host/tools/errors";
import { runCommand } from "@host/tools/run-shell";
import { cap } from "@host/tools/shared";
import type { Tool } from "@host/tools/types";
import { Effect, Schema } from "effect";

/**
 * Skill discovery + progressive disclosure.
 *
 * A skill is a `<root>/<id>/SKILL.md`: YAML frontmatter (name, description, optional `meta` with an
 * icon) followed by a markdown instruction body. Skills are discovered across an ORDERED list of
 * roots (D-087), highest precedence first: the PROJECT-LOCAL `<workspace>/.trevor/skills`, then the
 * configured/global root (`TREVOR_SKILLS_DIR`, else the shared agents/skills home). An enabled project-local
 * skill shadows a global one with the same id; a disabled project file is simply absent (it leaves no
 * tombstone, so the global skill of that id still surfaces).
 *
 * Progressive disclosure rides on the `skill` tool: its description lists every
 * skill's id + blurb (level 1, always in context), and `skill(name)` returns one
 * skill's full body on demand (level 2). Bodies are never loaded until asked for.
 *
 * Shell interpolation (H-175) is opt-in: when enabled, expanding a body runs the
 * two command forms and substitutes their stdout, through the same runCommand floor
 * the bash tool uses. Off by default because it executes commands at load time.
 *
 * Responsible for: skill discovery/registry across roots + progressive disclosure (roster, tool).
 * Not for: the `!command` interpolation trust gate - commands/interpolation.ts.
 */

/** The configured/global skills root: TREVOR_SKILLS_DIR when set, else the shared agents/skills home. */
export const SKILLS_DIR = resolve(
  process.env.TREVOR_SKILLS_DIR ?? join(homedir(), ".trevor", "skills"),
);

/** The project-local skills root: `<workspace>/.trevor/skills`, the same workspace authority the
 *  file tools (read/write/bash, edit confinement) use. */
export const PROJECT_SKILLS_DIR = resolve(WORKSPACE_ROOT, ".trevor", "skills");

/** Skill shell-interpolation is opt-in (it runs commands when a skill is loaded). */
export const SKILL_SHELL_INTERPOLATION =
  process.env.TREVOR_SKILL_SHELL === "1" || process.env.TREVOR_SKILL_SHELL === "true";

/** Which root a discovered skill came from: a project-local skill shadows a global one of the same id. */
export type SkillRootKind = "project" | "global";

/** One searched skill root, with its precedence kind. */
export interface SkillRoot {
  readonly kind: SkillRootKind;
  readonly dir: string;
}

/**
 * The ordered skill roots, highest precedence first: the project-local `<workspace>/.trevor/skills`,
 * then the configured/global root. Deduplicated by resolved dir - when the workspace IS the global
 * root, only one entry remains, so a root is never searched (or counted) twice.
 */
export function skillRoots(): SkillRoot[] {
  const roots: SkillRoot[] = [{ kind: "project", dir: PROJECT_SKILLS_DIR }];
  if (SKILLS_DIR !== PROJECT_SKILLS_DIR) {
    roots.push({ kind: "global", dir: SKILLS_DIR });
  }
  return roots;
}

/** One discovered skill. `icon` comes from the frontmatter `meta.icon`; `rootKind` is its provenance. */
export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon?: string;
  readonly path: string;
  /** Which root the SELECTED skill came from (project-local overrides global). */
  readonly rootKind: SkillRootKind;
}

/** Projects an `available` registry entry down to the selected-skill shape (SkillEntry supersets Skill). */
function skillOf(entry: SkillEntry): Skill {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    path: entry.path,
    rootKind: entry.rootKind,
  };
}

/**
 * Discovers skills across the ordered roots (project-local first, then global), selecting the first
 * enabled skill for each id - so a project-local skill OVERRIDES a global one of the same id, and a
 * disabled project file leaves no tombstone (the global skill of that id still wins). A projection of
 * `buildSkillRegistry`'s `available` entries, so the precedence/override/disabled rules live in ONE
 * walk: the roster and the registry can't disagree, and there's no second FS scan.
 */
export function discoverSkillsIn(roots: readonly SkillRoot[]): Skill[] {
  return buildSkillRegistry(roots)
    .filter((entry) => entry.status === "available")
    .map(skillOf);
}

/** Discovers skills across the effective roots (derived from the memoized registry; a missing root
 *  yields no skills). */
export function discoverSkills(): readonly Skill[] {
  return skillRegistry()
    .filter((entry) => entry.status === "available")
    .map(skillOf);
}

/** Clears the registry memo - for tests that vary the roots/fixtures between cases. */
export function resetSkillCache(): void {
  registryCache = null;
}

/**
 * A skill's status in the registry (D-075). Unlike `discoverSkills` (which returns only the SELECTED
 * enabled skills), the registry represents EVERY entry explicitly so nothing is silently dropped:
 *  - available: the selected, enabled skill for its id (first across the root order).
 *  - shadowed:  an enabled skill whose id a higher-precedence root already selected.
 *  - disabled:  a skill whose frontmatter set `disabled: true`.
 *  - malformed: an entry with no readable SKILL.md.
 */
export type SkillStatus = "available" | "shadowed" | "disabled" | "malformed";

/**
 * The kind of resource a registry record describes (D-075 M6). The first cut emits only `"skill"`,
 * but the field is the discriminant a later slice widens (to `"command"`, `"agent"`, …) so slash
 * commands, command families, and agents can join the SAME registry without changing this contract.
 * Consumers that want skills today filter on `resourceType === "skill"`, so future rows never leak.
 */
export type SkillResourceType = "skill";

/** One registry entry: the skill metadata plus its status + provenance (never a full body). */
export interface SkillEntry {
  /** The resource kind. Always `"skill"` in the skills-only first cut; the discriminant for later rows. */
  readonly resourceType: SkillResourceType;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The `Triggers:` tail of the description (when present), for search + display. */
  readonly triggers: string;
  readonly icon?: string;
  readonly path: string;
  readonly rootKind: SkillRootKind;
  readonly status: SkillStatus;
}

/**
 * Splits a skill description into its main blurb and the `Triggers:` tail (either may be ""). The ONE
 * owner of the "description up to Triggers:" parse, shared by the registry's `triggers` field, the
 * level-1 roster blurb, and the skills_list search blurb so the three can't split it differently.
 */
export function splitDescription(description: string): { blurb: string; triggers: string } {
  const parts = description.split(/\btriggers:/i);
  return {
    blurb: (parts[0] ?? "").trim() || description,
    triggers: parts.length > 1 ? (parts[1] ?? "").trim() : "",
  };
}

/**
 * Builds the full skill registry across the ordered roots: every entry, each tagged with its status
 * (available / shadowed / disabled / malformed) and provenance. Pure over the passed roots, so the
 * precedence + status rules are unit-tested with temp dirs. The model-facing roster + tools use only
 * the `available` entries; the rest are surfaced (not dropped) so a disabled/shadowed/malformed skill
 * is explainable.
 */
export function buildSkillRegistry(roots: readonly SkillRoot[]): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const selected = new Set<string>();

  for (const root of roots) {
    for (const entry of sortedVisibleEntries(root.dir)) {
      const path = join(root.dir, entry, "SKILL.md");
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        entries.push({
          resourceType: "skill",
          id: entry,
          name: entry,
          description: "",
          triggers: "",
          path,
          rootKind: root.kind,
          status: "malformed",
        });
        continue;
      }
      const { data } = parseFrontmatter(text);
      const description = (trimStr(data.description) ?? "").replace(/\s+/g, " ").trim();
      const meta =
        data.meta && typeof data.meta === "object" ? (data.meta as Record<string, unknown>) : {};
      const base = {
        resourceType: "skill" as const,
        id: entry,
        name: trimStr(data.name) ?? entry,
        description,
        triggers: splitDescription(description).triggers,
        icon: trimStr(meta.icon),
        path,
        rootKind: root.kind,
      };
      const status: SkillStatus =
        data.disabled === true ? "disabled" : selected.has(entry) ? "shadowed" : "available";
      if (status === "available") {
        selected.add(entry);
      }
      entries.push({ ...base, status });
    }
  }

  return entries.sort((a, b) => a.id.localeCompare(b.id) || a.rootKind.localeCompare(b.rootKind));
}

let registryCache: SkillEntry[] | null = null;

/** The full skill registry across the effective roots (memoized; cleared by resetSkillCache). */
export function skillRegistry(): readonly SkillEntry[] {
  if (!registryCache) {
    registryCache = buildSkillRegistry(skillRoots());
  }
  return registryCache;
}

/**
 * Renders the `/skills` output: every discovered skill with its source root, or - when the library is
 * empty - the full list of roots that were searched (so an empty result is never silent about where
 * it looked). Pure over the skills + roots, so the command's output is unit-tested directly.
 */
export function renderSkillsList(skills: readonly Skill[], roots: readonly SkillRoot[]): string {
  if (!skills.length) {
    return `No skills found. Searched: ${roots.map((r) => `${r.dir} (${r.kind})`).join(", ")}.`;
  }
  return skills
    .map((s) => `${s.icon ? `${s.icon} ` : ""}${s.id} [${s.rootKind}] - ${s.description}`)
    .join("\n");
}

/**
 * The `/skills` immediate command, owned here so commands.ts no longer reaches into skill-discovery
 * internals: it lists every discovered skill with its source root, or reports every searched root when
 * the library is empty. Registered from commands.ts as one line. Reads no runtime context.
 */
export function buildSkillCommand(): Command {
  return {
    spec: { name: "/skills", summary: "List discovered skills" },
    select: () => undefined,
    run: () => renderSkillsList(discoverSkills(), skillRoots()),
  };
}

/**
 * The skill-shell execution policy (provenance `skill-shell`, plan 40 M1): every runnable segment - a
 * fenced ```` ```! ```` script or a whole-line `!command` - runs through the shared runCommand floor, so
 * the always-prevented classification, timeout, and output cap apply. Unlike the command-file lane this
 * runs an ARBITRARY command (bounded, not allow-listed); it is a SEPARATE opt-in seam (TREVOR_SKILL_SHELL)
 * and never armed by the command-file gate. Parsing is shared with command files; only this policy differs.
 */
const skillShellExecutor: SegmentExecutor = async (segment) =>
  (await runCommand(segment.kind === "command" ? segment.command : segment.script)).output;

/**
 * Runs the two skill shell-interpolation forms and substitutes stdout in place, through the shared
 * interpolation parser + renderer. Behavior is unchanged from the original inline implementation: the
 * parser finds the same `!command` / ```` ```! ```` forms, and {@link skillShellExecutor} runs each via
 * runCommand.
 */
async function interpolateShell(body: string): Promise<string> {
  return interpolate(body, skillShellExecutor);
}

/** Loads a skill's instruction body (frontmatter stripped, interpolation applied if on). */
export async function expandSkill(skill: Skill): Promise<string> {
  let text: string;

  try {
    text = readFileSync(skill.path, "utf8");
  } catch {
    return `error: cannot read skill "${skill.id}"`;
  }

  const { body } = parseFrontmatter(text);
  const expanded = SKILL_SHELL_INTERPOLATION ? await interpolateShell(body) : body;

  return cap(expanded.trim());
}

/**
 * A one-line level-1 blurb: the description up to its "Triggers:" tail, capped.
 * The full multi-sentence frontmatter description (with triggers) is far too large
 * to inline for every skill - 37 of those blow a small model's context window - so
 * the always-present inventory stays terse; the full body loads on demand (level 2).
 */
function blurb(description: string): string {
  const main = splitDescription(description).blurb;
  return main.length > 90 ? `${main.slice(0, 90).trimEnd()}…` : main;
}

/** The ambient roster inlines at most this many skills; any surplus is reachable via `skills_list`. */
export const SKILL_ROSTER_CAP = 40;

/**
 * The compact level-1 roster embedded in the `skill` tool description: one terse `- id: blurb` line
 * per skill (D-075 M2), capped at {@link SKILL_ROSTER_CAP}. When more skills exist than fit, the
 * surplus is NOT silently dropped: it is summarised with an explicit count (shown / total) plus a
 * pointer to `skills_list(query)`, so the model knows unshown skills exist and how to reach them by
 * keyword - never a speculative load of every body. Pure over the passed skills, so capping +
 * truncation marking are unit-tested directly.
 */
export function buildSkillRoster(skills: readonly Skill[], capCount = SKILL_ROSTER_CAP): string {
  const shown = skills.slice(0, capCount);
  const lines = shown.map((s) => `- ${s.icon ? `${s.icon} ` : ""}${s.id}: ${blurb(s.description)}`);
  const hidden = skills.length - shown.length;
  if (hidden > 0) {
    lines.push(
      `…and ${hidden} more skill${hidden === 1 ? "" : "s"} not shown (${skills.length} total) - call skills_list(query) to find them by keyword.`,
    );
  }
  return lines.join("\n");
}

/**
 * The progressive-disclosure tool: its description lists every skill's id + a terse
 * blurb (level 1) and `skill(name)` returns one skill's full instructions (level 2).
 * Returned only when skills exist, so an empty library advertises no tool.
 */
const SkillParams = Schema.Struct({
  name: Schema.String.annotations({ description: "The skill id to load" }),
});

export function buildSkillTool(skills: readonly Skill[]): Tool<typeof SkillParams.Type> {
  const list = buildSkillRoster(skills);

  return {
    name: "skill",
    description: `Load a skill's full instructions by id and then follow them. Use a skill when the task matches its description or triggers. Skills are optional, not mandatory: when ordinary repository context, files, and tools already cover the task, proceed without loading one. Available skills:\n${list}`,
    params: SkillParams,
    execute: (args) => {
      const id = args.name.trim();
      const skill = skills.find((s) => s.id === id);

      if (!skill) {
        // An unknown id is a value (domain) failure; surface it as a typed input error.
        return Effect.fail(
          new ToolInputError({
            tool: "skill",
            detail: `unknown skill "${id}". Available: ${skills.map((s) => s.id).join(", ") || "(none)"}`,
          }),
        );
      }

      // expandSkill never rejects (it catches its own read), so Effect.promise is safe.
      return Effect.promise(() => expandSkill(skill));
    },
  };
}
