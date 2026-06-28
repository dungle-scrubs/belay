import { Schema } from "effect";
import { expandSkill, type SkillEntry, skillRegistry } from "../skills";
import { simpleTool, toolInput } from "./shared";

/**
 * `skill_view` (D-075 M4): loads exactly ONE selected skill's full instruction body by id (level-2
 * drill-in), with a small provenance header. The model calls it only for the specific skill it
 * intends to use - never for every listed skill. Unknown ids return a structured not-found; a
 * disabled or malformed skill is reported as such rather than pretending it is usable. Read-only:
 * existing shell-interpolation trust gating inside the body loader is preserved (it never runs here
 * unless the operator opted in via TREVOR_SKILL_SHELL).
 */

const Params = Schema.Struct({
  skill_id: Schema.String.annotations({ description: "The id of the single skill to load." }),
});

/**
 * The resolved outcome of a `skill_view` lookup. The body case carries the single chosen entry +
 * its provenance header; the rest are terminal messages. Pure so the selection rules (one-body
 * loading, unknown / disabled / malformed handling, available-over-shadowed precedence) are unit-
 * tested over a registry without touching the global memo or the filesystem.
 */
export type SkillViewResolution =
  | { readonly kind: "not-found"; readonly message: string }
  | { readonly kind: "disabled"; readonly message: string }
  | { readonly kind: "malformed"; readonly message: string }
  | { readonly kind: "body"; readonly header: string; readonly entry: SkillEntry };

/** Resolves a `skill_view` request against a registry: which single skill (if any) to load, or why not. */
export function resolveSkillView(
  registry: readonly SkillEntry[],
  rawId: string,
): SkillViewResolution {
  const id = rawId.trim();
  // Prefer the SELECTED (available) entry for the id, so a shadowing project skill wins over the
  // shadowed global one; fall back to any same-id entry only to explain a disabled/malformed result.
  const entry =
    registry.find((e) => e.id === id && e.status === "available") ??
    registry.find((e) => e.id === id);

  if (!entry) {
    const available = registry.filter((e) => e.status === "available").map((e) => e.id);
    return {
      kind: "not-found",
      message: `unknown skill "${id}". Available: ${available.join(", ") || "(none)"}`,
    };
  }
  if (entry.status === "disabled") {
    return {
      kind: "disabled",
      message: `skill "${id}" is disabled (frontmatter disabled: true), so it cannot be loaded.`,
    };
  }
  if (entry.status === "malformed") {
    return {
      kind: "malformed",
      message: `skill "${id}" has no readable SKILL.md at ${entry.path}.`,
    };
  }
  return {
    kind: "body",
    header: `# ${entry.name} (${entry.id}) [${entry.rootKind}]\n\n`,
    entry,
  };
}

export const skillViewTool = simpleTool({
  name: "skill_view",
  description:
    "Load ONE skill's full instructions by id, then follow them. Call this only for the specific " +
    "skill you intend to use - not for every listed skill. Use skills_list first to find the id.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: async (args) => {
    const res = resolveSkillView(skillRegistry(), args.skill_id);
    if (res.kind === "not-found") {
      return toolInput(res.message);
    }
    if (res.kind === "disabled" || res.kind === "malformed") {
      return res.message;
    }
    // A SkillEntry is a superset of Skill; expandSkill catches its own read errors (never rejects).
    return res.header + (await expandSkill(res.entry));
  },
});
