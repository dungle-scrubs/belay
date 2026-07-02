/**
 * Responsible for: the glob tool - listing workspace paths for a pattern with a capped,
 * honestly-truncated result.
 * Not for: the shared workspace walk - search.ts.
 */
import { Schema } from "effect";
import { collectWorkspace } from "./search";
import { simpleTool } from "./shared";

export const MAX_GLOB = 500;

const Params = Schema.Struct({
  pattern: Schema.String.annotations({ description: "Glob pattern, relative to the workspace" }),
});

/**
 * Formats matched paths for the model: a count header, or - when the cap was hit - an honest
 * "first N (more exist), narrow the pattern" notice rather than a silent marker that would imply
 * the sorted slice is the whole set. Pure (no IO), so the shaping is unit-tested directly.
 */
export function shapeGlob(matches: readonly string[], truncated: boolean): string {
  if (matches.length === 0) {
    return "(no matches)";
  }
  const body = [...matches].sort().join("\n");
  if (truncated) {
    return (
      `Showing the first ${MAX_GLOB} matches (more exist). Narrow the pattern - a subdirectory ` +
      `or extension, e.g. src/**/*.ts - to see the rest.\n${body}`
    );
  }
  return `${matches.length} match${matches.length === 1 ? "" : "es"}\n${body}`;
}

/** Lists workspace files matching a glob pattern. */
export const globTool = simpleTool({
  name: "glob",
  description: "List workspace files matching a glob pattern, e.g. 'src/**/*.ts'.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: async (args) => {
    const { items, truncated } = await collectWorkspace(args.pattern, MAX_GLOB, (entry) => entry);
    return shapeGlob(items, truncated);
  },
});
