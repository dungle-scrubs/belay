import { glob } from "node:fs/promises";
import { Effect } from "effect";
import { ToolExecutionError } from "./errors";
import { cap, msg, SKIP_DIRS } from "./shared";
import type { Tool } from "./types";
import { WORKSPACE_ROOT } from "./workspace";

const MAX_GLOB = 500;

/** Lists workspace files matching a glob pattern. */
export const globTool: Tool = {
  name: "glob",
  description: "List workspace files matching a glob pattern, e.g. 'src/**/*.ts'.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the workspace" },
    },
    required: ["pattern"],
  },
  execute: (args) =>
    Effect.tryPromise({
      try: async () => {
        const matches: string[] = [];
        for await (const entry of glob(String(args.pattern ?? ""), { cwd: WORKSPACE_ROOT })) {
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
      },
      catch: (cause) => new ToolExecutionError({ tool: "glob", detail: msg(cause), cause }),
    }),
};
