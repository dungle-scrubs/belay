import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { Effect } from "effect";
import { applyUniqueReplacement, replaceMissMessage } from "./replace";
import { tryTool, tryToolSync } from "./shared";
import type { Tool } from "./types";
import { confine, WORKSPACE_ROOT } from "./workspace";

/** Replaces a unique exact substring in a workspace file (like an apply-patch). */
export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact substring in a workspace file. 'old' must appear exactly once. Confined to the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path within the workspace" },
      old: { type: "string", description: "Exact text to replace (must be unique in the file)" },
      new: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old", "new"],
  },
  execute: (args) =>
    Effect.gen(function* () {
      const old = String(args.old ?? "");
      if (old === "") {
        return "error: 'old' must be non-empty";
      }
      // confine throws on a path escape; the fs calls reject - both become the same
      // typed failure, which the executor renders to one `error: …` line.
      const target = yield* tryToolSync("edit", () => confine(String(args.path ?? "")));
      const content = yield* tryTool("edit", () => readFile(target, "utf8"));
      const result = applyUniqueReplacement(content, old, String(args.new ?? ""));
      if (!result.ok) {
        return replaceMissMessage(result);
      }
      yield* tryTool("edit", () => writeFile(target, result.content, "utf8"));
      return `edited ${relative(WORKSPACE_ROOT, target)}`;
    }),
};
