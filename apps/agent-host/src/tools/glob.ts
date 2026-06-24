import { glob } from "node:fs/promises";
import { Schema } from "effect";
import { cap, SKIP_DIRS, tryTool } from "./shared";
import type { Tool } from "./types";
import { WORKSPACE_ROOT } from "./workspace";

const MAX_GLOB = 500;

const Params = Schema.Struct({
  pattern: Schema.String.annotations({ description: "Glob pattern, relative to the workspace" }),
});

/** Lists workspace files matching a glob pattern. */
export const globTool: Tool<typeof Params.Type> = {
  name: "glob",
  description: "List workspace files matching a glob pattern, e.g. 'src/**/*.ts'.",
  params: Params,
  execute: (args) =>
    tryTool("glob", async () => {
      const matches: string[] = [];
      for await (const entry of glob(args.pattern, { cwd: WORKSPACE_ROOT })) {
        if (SKIP_DIRS.test(`/${entry}/`)) {
          continue;
        }
        matches.push(entry);
        if (matches.length >= MAX_GLOB) {
          matches.push(`…[capped at ${MAX_GLOB}]`);
          break;
        }
      }
      return cap(matches.length > 0 ? matches.sort().join("\n") : "(no matches)");
    }),
};
