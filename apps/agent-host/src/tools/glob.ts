import { glob } from "node:fs/promises";
import { Schema } from "effect";
import { cap, SKIP_DIRS, tryTool } from "./shared";
import type { Tool } from "./types";
import { WORKSPACE_ROOT } from "./workspace";

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
export const globTool: Tool<typeof Params.Type> = {
  name: "glob",
  description: "List workspace files matching a glob pattern, e.g. 'src/**/*.ts'.",
  params: Params,
  readOnly: true,
  execute: (args) =>
    tryTool("glob", async () => {
      const matches: string[] = [];
      let truncated = false;
      for await (const entry of glob(args.pattern, { cwd: WORKSPACE_ROOT })) {
        if (SKIP_DIRS.test(`/${entry}/`)) {
          continue;
        }
        // Hitting the cap with another match still to come means this is an incomplete slice:
        // record it and stop, so `truncated` distinguishes "exactly MAX_GLOB" from "more exist".
        if (matches.length >= MAX_GLOB) {
          truncated = true;
          break;
        }
        matches.push(entry);
      }
      return cap(shapeGlob(matches, truncated));
    }),
};
