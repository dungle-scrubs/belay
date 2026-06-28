import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import type { Command } from "./commands";
import { WORKSPACE_ROOT } from "./paths";
// Leaf imports, not the `./tools` barrel: the barrel's TOOLS array calls `buildSkillTool`/
// `discoverSkills` at top level, so importing the barrel here would be a fatal initialization cycle
// (the barrel re-exports these same names for external consumers).
import { ToolInputError } from "./tools/errors";
import { renderShell, runShell } from "./tools/run-shell";
import { cap } from "./tools/shared";
import type { Tool } from "./tools/types";

/**
 * Skill discovery + progressive disclosure.
 *
 * A skill is a `<root>/<id>/SKILL.md`: YAML frontmatter (name, description, optional `meta` with an
 * icon) followed by a markdown instruction body. Skills are discovered across an ORDERED list of
 * roots (D-087), highest precedence first: the PROJECT-LOCAL `<workspace>/.agents/skills`, then the
 * configured/global root (`TREVOR_SKILLS_DIR`, else `~/.agents/skills`). An enabled project-local
 * skill shadows a global one with the same id; a disabled project file is simply absent (it leaves no
 * tombstone, so the global skill of that id still surfaces).
 *
 * Progressive disclosure rides on the `skill` tool: its description lists every
 * skill's id + blurb (level 1, always in context), and `skill(name)` returns one
 * skill's full body on demand (level 2). Bodies are never loaded until asked for.
 *
 * Shell interpolation (H-175) is opt-in: when enabled, expanding a body runs the
 * two command forms and substitutes their stdout, through the same runShell floor
 * the bash tool uses. Off by default because it executes commands at load time.
 */

/** The configured/global skills root: TREVOR_SKILLS_DIR when set, else ~/.agents/skills. */
export const SKILLS_DIR = resolve(
  process.env.TREVOR_SKILLS_DIR ?? join(homedir(), ".agents", "skills"),
);

/** The project-local skills root: `<workspace>/.agents/skills`, the same workspace authority the
 *  file tools (read/write/bash, edit confinement) use. */
export const PROJECT_SKILLS_DIR = resolve(WORKSPACE_ROOT, ".agents", "skills");

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
 * The ordered skill roots, highest precedence first: the project-local `<workspace>/.agents/skills`,
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

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Splits a SKILL.md into parsed frontmatter data and the remaining body. */
function parseFrontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = text.match(FRONTMATTER);

  if (!match) {
    return { data: {}, body: text };
  }

  let data: Record<string, unknown> = {};

  try {
    const parsed = parseYaml(match[1] ?? "");

    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }

  return { data, body: text.slice(match[0].length) };
}

const trimStr = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() : undefined;

/** Builds a Skill from a SKILL.md, or null if its frontmatter disables it. */
function toSkill(id: string, path: string, text: string, rootKind: SkillRootKind): Skill | null {
  const { data } = parseFrontmatter(text);

  if (data.disabled === true) {
    return null;
  }

  const meta =
    data.meta && typeof data.meta === "object" ? (data.meta as Record<string, unknown>) : {};

  return {
    id,
    name: trimStr(data.name) ?? id,
    // Collapse folded-scalar whitespace so the level-1 blurb is one tidy line.
    description: (trimStr(data.description) ?? "").replace(/\s+/g, " ").trim(),
    icon: trimStr(meta.icon),
    path,
    rootKind,
  };
}

/**
 * Discovers skills across the ordered roots (project-local first, then global), selecting the first
 * enabled skill for each id - so a project-local skill OVERRIDES a global one of the same id, and a
 * disabled project file leaves no tombstone (the global skill of that id still wins). A missing or
 * unreadable root contributes nothing. Pure over the passed roots, so the precedence + override rules
 * are unit-tested with temp dirs (the memoized `discoverSkills` wraps it over the default roots).
 */
export function discoverSkillsIn(roots: readonly SkillRoot[]): Skill[] {
  const byId = new Map<string, Skill>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root.dir);
    } catch {
      continue; // missing / unreadable root: nothing from here
    }
    for (const entry of entries.sort()) {
      // A higher-precedence root already selected this id (entry === id), so skip without reading.
      // A DISABLED file in a higher root never reached `byId`, so its id stays open for a lower root.
      if (entry.startsWith(".") || byId.has(entry)) {
        continue;
      }
      const path = join(root.dir, entry, "SKILL.md");
      try {
        // No statSync pre-check: readFileSync throws (caught below) when the entry is a plain file or
        // a dir without a SKILL.md, which is exactly what we skip.
        const skill = toSkill(entry, path, readFileSync(path, "utf8"), root.kind);
        if (skill) {
          byId.set(skill.id, skill);
        }
      } catch {
        // No readable SKILL.md here - skip it.
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

let cache: Skill[] | null = null;

/** Discovers skills across the effective roots (memoized; a missing root yields no skills). */
export function discoverSkills(): readonly Skill[] {
  if (!cache) {
    cache = discoverSkillsIn(skillRoots());
  }
  return cache;
}

/** Clears the discovery memo - for tests that vary the roots/fixtures between cases. */
export function resetSkillCache(): void {
  cache = null;
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

/** Splits a description into its main blurb source and the `Triggers:` tail (either may be ""). */
function extractTriggers(description: string): string {
  const parts = description.split(/\btriggers:/i);
  return parts.length > 1 ? (parts[1] ?? "").trim() : "";
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
    let names: string[];
    try {
      names = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const entry of names.sort()) {
      if (entry.startsWith(".")) {
        continue;
      }
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
        triggers: extractTriggers(description),
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
 * Runs the two skill shell-interpolation forms and substitutes stdout in place:
 *   - a fenced block opening with ```! (a multi-line script), and
 *   - a single line that is just `!command` (excluding markdown images `![`).
 * Every command goes through runShell, so the safety floor, timeout, and cap apply.
 */
async function interpolateShell(body: string): Promise<string> {
  const lines = body.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (/^```!\s*$/.test(trimmed)) {
      const script: string[] = [];

      i += 1;

      for (; i < lines.length; i += 1) {
        const inner = lines[i] ?? "";

        if (/^```\s*$/.test(inner.trim())) {
          break;
        }

        script.push(inner);
      }

      out.push(renderShell(await runShell(script.join("\n"))));

      continue; // i sits on the closing fence (or end); the loop step moves past it.
    }

    if (trimmed.length > 1 && trimmed.startsWith("!") && trimmed[1] !== "[") {
      out.push(renderShell(await runShell(trimmed.slice(1).trim())));
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
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
  const main = (description.split(/\btriggers:/i)[0] ?? description).trim() || description;
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
