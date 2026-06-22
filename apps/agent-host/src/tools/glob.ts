import { glob } from "node:fs/promises";
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
  async execute(args) {
    const pattern = String(args.pattern ?? "");
    try {
      const matches: string[] = [];
      for await (const entry of glob(pattern, { cwd: WORKSPACE_ROOT })) {
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
    } catch (error) {
      return `error: ${msg(error)}`;
    }
  },
};
