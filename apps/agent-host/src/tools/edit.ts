import { writeFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { prepareEdit } from "./edit-core";
import { defineTool } from "./shared";

const Params = Schema.Struct({
  path: Schema.String.annotations({ description: "File path within the workspace" }),
  old: Schema.String.annotations({
    description: "Exact text to replace (must be unique in the file)",
  }),
  new: Schema.String.annotations({ description: "Replacement text" }),
});

/** Replaces a unique exact substring in a workspace file (like an apply-patch). */
export const editTool = defineTool({
  name: "edit",
  description:
    "Replace an exact substring in a workspace file. 'old' must appear exactly once. Confined to the workspace.",
  params: Params,
  execute: (args, ops) =>
    Effect.gen(function* () {
      if (args.old === "") {
        return yield* ops.reject("'old' must be non-empty");
      }
      // The single-file, single-edit case of the multi_edit core: confine -> read -> replace.
      const prepared = yield* prepareEdit(ops, args.path, [{ old: args.old, new: args.new }]);
      yield* ops.attempt(() => writeFile(prepared.target, prepared.content, "utf8"));
      return `edited ${prepared.rel}`;
    }),
});
