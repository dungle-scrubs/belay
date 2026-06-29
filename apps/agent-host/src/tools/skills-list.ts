import { Schema } from "effect";
import { type SkillEntry, skillRegistry, splitDescription } from "../skills";
import { simpleTool } from "./shared";

/**
 * `skills_list` (D-075 M3): a searchable, read-only view over the skill registry METADATA - ids,
 * descriptions, trigger summaries, provenance, and status - never full bodies. The model calls it
 * when the ambient roster is missing, truncated, too broad, or insufficient; it then loads exactly
 * one chosen skill with `skill_view`. Bounded by a default + max limit so results can't bloat context.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const Params = Schema.Struct({
  query: Schema.optional(Schema.String).annotations({
    description: "Filter skills by id, name, description, or triggers (all terms must match).",
  }),
  limit: Schema.optional(Schema.Number).annotations({
    description: "Max skills to return (default 20, max 50).",
  }),
});

/** Whether every query term appears somewhere in a skill's searchable metadata. */
function matchesQuery(entry: SkillEntry, terms: readonly string[]): boolean {
  if (terms.length === 0) {
    return true;
  }
  const hay = `${entry.id} ${entry.name} ${entry.description} ${entry.triggers}`.toLowerCase();
  return terms.every((term) => hay.includes(term));
}

/** The blurb (description up to its Triggers: tail) for a compact list line. */
function blurbOf(entry: SkillEntry): string {
  return splitDescription(entry.description).blurb;
}

/**
 * Renders the searched skills list (pure): available skills always, plus disabled/shadowed/malformed
 * ones only when a query matches them (so the model can learn WHY a skill it expected isn't usable).
 * Bounded by `limit` with explicit truncation. Empty registry vs no-match are distinguished.
 */
export function formatSkillsList(
  registry: readonly SkillEntry[],
  query: string | undefined,
  limit: number,
): string {
  const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const cap = Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);

  const available = registry.filter((e) => e.status === "available" && matchesQuery(e, terms));
  const others = terms.length
    ? registry.filter((e) => e.status !== "available" && matchesQuery(e, terms))
    : [];
  const all = [...available, ...others];
  const shown = all.slice(0, cap);

  if (shown.length === 0) {
    return registry.length === 0 ? "No skills are installed." : `No skills match "${query ?? ""}".`;
  }

  const lines = shown.map((e) => {
    const tag = e.status === "available" ? e.rootKind : `${e.status}, ${e.rootKind}`;
    const triggers = e.triggers ? ` (triggers: ${e.triggers})` : "";
    return `${e.id} [${tag}] - ${blurbOf(e)}${triggers}`;
  });
  const truncated = all.length > shown.length ? ` (truncated to ${cap})` : "";
  const header = `${shown.length} of ${all.length} skill${all.length === 1 ? "" : "s"}${truncated}:`;
  return [header, ...lines].join("\n");
}

export const skillsListTool = simpleTool({
  name: "skills_list",
  description:
    "List or search the available skills by id, name, description, or triggers. Returns compact " +
    "metadata only (ids, blurbs, triggers, status) - NOT skill bodies. Use it when the skill you " +
    "want is not in the ambient roster or the roster is too broad; then load one with skill_view.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: (args) => formatSkillsList(skillRegistry(), args.query, args.limit ?? DEFAULT_LIMIT),
});
