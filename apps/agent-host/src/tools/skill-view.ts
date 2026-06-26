import { Effect, Schema } from "effect";
import { expandSkill, skillRegistry } from "../skills";
import { defineTool } from "./shared";

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

export const skillViewTool = defineTool({
  name: "skill_view",
  description:
    "Load ONE skill's full instructions by id, then follow them. Call this only for the specific " +
    "skill you intend to use - not for every listed skill. Use skills_list first to find the id.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: (args, ops) => {
    const id = args.skill_id.trim();
    const registry = skillRegistry();
    const entry =
      registry.find((e) => e.id === id && e.status === "available") ??
      registry.find((e) => e.id === id);

    if (!entry) {
      const available = registry.filter((e) => e.status === "available").map((e) => e.id);
      return ops.reject(`unknown skill "${id}". Available: ${available.join(", ") || "(none)"}`);
    }
    if (entry.status === "disabled") {
      return Effect.succeed(
        `skill "${id}" is disabled (frontmatter disabled: true), so it cannot be loaded.`,
      );
    }
    if (entry.status === "malformed") {
      return Effect.succeed(`skill "${id}" has no readable SKILL.md at ${entry.path}.`);
    }

    const header = `# ${entry.name} (${entry.id}) [${entry.rootKind}${entry.status === "shadowed" ? ", shadowed" : ""}]\n\n`;
    // expandSkill catches its own read errors (never rejects), so Effect.promise is safe.
    return Effect.promise(() =>
      expandSkill({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        icon: entry.icon,
        path: entry.path,
        rootKind: entry.rootKind,
      }),
    ).pipe(Effect.map((body) => header + body));
  },
});
