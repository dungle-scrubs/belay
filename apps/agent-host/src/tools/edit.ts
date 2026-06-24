import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { Effect, Schema } from "effect";
import { ToolInputError } from "./errors";
import { applyUniqueReplacement, replaceMissMessage } from "./replace";
import { tryTool, tryToolSync } from "./shared";
import type { Tool } from "./types";
import { confine, WORKSPACE_ROOT } from "./workspace";

const Params = Schema.Struct({
  path: Schema.String.annotations({ description: "File path within the workspace" }),
  old: Schema.String.annotations({
    description: "Exact text to replace (must be unique in the file)",
  }),
  new: Schema.String.annotations({ description: "Replacement text" }),
});

/** Replaces a unique exact substring in a workspace file (like an apply-patch). */
export const editTool: Tool<typeof Params.Type> = {
  name: "edit",
  description:
    "Replace an exact substring in a workspace file. 'old' must appear exactly once. Confined to the workspace.",
  params: Params,
  execute: (args) =>
    Effect.gen(function* () {
      if (args.old === "") {
        return yield* Effect.fail(
          new ToolInputError({ tool: "edit", detail: "'old' must be non-empty" }),
        );
      }
      // confine throws on a path escape; the fs calls reject - both become the same
      // typed failure, which the executor renders to one `error: …` line.
      const target = yield* tryToolSync("edit", () => confine(args.path));
      const content = yield* tryTool("edit", () => readFile(target, "utf8"));
      const result = applyUniqueReplacement(content, args.old, args.new);
      if (!result.ok) {
        // replaceMissMessage opens with `error: `; strip it so the executor's own
        // `error: edit failed - ` prefix isn't doubled (the wording is otherwise pinned).
        const detail = replaceMissMessage(result).replace(/^error:\s*/u, "");
        return yield* Effect.fail(new ToolInputError({ tool: "edit", detail }));
      }
      yield* tryTool("edit", () => writeFile(target, result.content, "utf8"));
      return `edited ${relative(WORKSPACE_ROOT, target)}`;
    }),
};
