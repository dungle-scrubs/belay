import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import { ToolInputError } from "./tools/errors";
import { renderShell, runShell } from "./tools/run-shell";
import { cap } from "./tools/shared";
import type { Tool } from "./tools/types";

/**
 * Skill discovery + progressive disclosure.
 *
 * A skill is a `<SKILLS_DIR>/<id>/SKILL.md`: YAML frontmatter (name, description,
 * optional `meta` with an icon) followed by a markdown instruction body. The dir is
 * configurable and defaults to the shared agent skill library.
 *
 * Progressive disclosure rides on the `skill` tool: its description lists every
 * skill's id + blurb (level 1, always in context), and `skill(name)` returns one
 * skill's full body on demand (level 2). Bodies are never loaded until asked for.
 *
 * Shell interpolation (H-175) is opt-in: when enabled, expanding a body runs the
 * two command forms and substitutes their stdout, through the same runShell floor
 * the bash tool uses. Off by default because it executes commands at load time.
 */

/** Configurable skills root; one skill per `<dir>/<id>/SKILL.md`. */
export const SKILLS_DIR = resolve(
  process.env.TREVOR_SKILLS_DIR ?? join(homedir(), ".agents", "skills"),
);

/** Skill shell-interpolation is opt-in (it runs commands when a skill is loaded). */
export const SKILL_SHELL_INTERPOLATION =
  process.env.TREVOR_SKILL_SHELL === "1" || process.env.TREVOR_SKILL_SHELL === "true";

/** One discovered skill. `icon` comes from the frontmatter `meta.icon`. */
export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon?: string;
  readonly path: string;
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
function toSkill(id: string, path: string, text: string): Skill | null {
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
  };
}

let cache: Skill[] | null = null;

/** Discovers skills under SKILLS_DIR (memoized; a missing dir yields no skills). */
export function discoverSkills(): readonly Skill[] {
  if (cache) {
    return cache;
  }

  const skills: Skill[] = [];

  let entries: string[];

  try {
    entries = readdirSync(SKILLS_DIR);
  } catch {
    cache = [];
    return cache;
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) {
      continue;
    }

    const path = join(SKILLS_DIR, entry, "SKILL.md");

    try {
      // No statSync pre-check: readFileSync throws (caught below) when the entry is
      // a plain file or a dir without a SKILL.md, which is exactly what we skip.
      const skill = toSkill(entry, path, readFileSync(path, "utf8"));

      if (skill) {
        skills.push(skill);
      }
    } catch {
      // No readable SKILL.md here - skip it.
    }
  }

  cache = skills;

  return skills;
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

/**
 * The progressive-disclosure tool: its description lists every skill's id + a terse
 * blurb (level 1) and `skill(name)` returns one skill's full instructions (level 2).
 * Returned only when skills exist, so an empty library advertises no tool.
 */
const SkillParams = Schema.Struct({
  name: Schema.String.annotations({ description: "The skill id to load" }),
});

export function buildSkillTool(skills: readonly Skill[]): Tool<typeof SkillParams.Type> {
  const list = skills
    .map((s) => `- ${s.icon ? `${s.icon} ` : ""}${s.id}: ${blurb(s.description)}`)
    .join("\n");

  return {
    name: "skill",
    description: `Load a skill's full instructions by id and then follow them. Use a skill when the task matches its description or triggers. Available skills:\n${list}`,
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
