import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { Effect, Schema } from "effect";
import { ToolInputError } from "./errors";
import { applyUniqueReplacement, replaceMissMessage } from "./replace";
import { tryTool, tryToolSync } from "./shared";
import type { Tool } from "./types";
import { confine, WORKSPACE_ROOT } from "./workspace";

const Params = Schema.Struct({
  edits: Schema.Array(
    Schema.Struct({
      path: Schema.String.annotations({ description: "File path within the workspace" }),
      old: Schema.String.annotations({
        description: "Exact text to replace (unique in the file here)",
      }),
      new: Schema.String.annotations({ description: "Replacement text" }),
    }),
  ).annotations({
    description: "Edits applied in order. Repeat a path to make several edits to one file.",
  }),
});

/**
 * Applies several exact-substring replacements atomically - many edits to one file
 * and/or edits across multiple files. Edits run in order (later edits see earlier
 * ones); each `old` must be unique in that file at the point it applies. Reads and
 * applies everything in memory first, then writes - so a single failed edit leaves
 * no file changed.
 */
export const multiEditTool: Tool<typeof Params.Type> = {
  name: "multi_edit",
  description:
    "Apply several exact-substring replacements atomically across one or more workspace files. " +
    "Edits apply in order (later edits see earlier ones); each 'old' must appear exactly once in " +
    "its file at that point. All-or-nothing: if any edit fails, no file is written. Confined to the workspace.",
  params: Params,
  execute: (args) =>
    Effect.gen(function* () {
      const edits = args.edits;
      if (edits.length === 0) {
        return yield* Effect.fail(
          new ToolInputError({ tool: "multi_edit", detail: "'edits' must be a non-empty array" }),
        );
      }

      // The schema guarantees each edit has string path/old/new; validate the value-level
      // preconditions (non-empty path and old) the old code checked.
      for (const edit of edits) {
        if (!edit.path) {
          return yield* Effect.fail(
            new ToolInputError({ tool: "multi_edit", detail: "each edit needs a 'path'" }),
          );
        }
        if (edit.old === "") {
          return yield* Effect.fail(
            new ToolInputError({
              tool: "multi_edit",
              detail: `'old' must be non-empty (${edit.path})`,
            }),
          );
        }
      }

      // Group by path, preserving first-seen order.
      const order: string[] = [];
      const byPath = new Map<string, { old: string; new: string }[]>();
      for (const edit of edits) {
        const list = byPath.get(edit.path);
        if (list) {
          list.push({ old: edit.old, new: edit.new });
        } else {
          byPath.set(edit.path, [{ old: edit.old, new: edit.new }]);
          order.push(edit.path);
        }
      }

      // Phase 1: read each file and apply its edits in memory. Any miss aborts here,
      // before a single write, so the workspace is never left half-edited.
      const pending: { target: string; rel: string; content: string }[] = [];
      for (const path of order) {
        const target = yield* tryToolSync("multi_edit", () => confine(path));
        let content = yield* tryTool("multi_edit", () => readFile(target, "utf8"));
        for (const edit of byPath.get(path) ?? []) {
          const result = applyUniqueReplacement(content, edit.old, edit.new);
          if (!result.ok) {
            // replaceMissMessage opens with `error: `; strip it so the executor's own
            // prefix isn't doubled (the wording, with the ` in <path>` suffix, is pinned).
            const detail = replaceMissMessage(result, ` in ${path}`).replace(/^error:\s*/u, "");
            return yield* Effect.fail(new ToolInputError({ tool: "multi_edit", detail }));
          }
          content = result.content;
        }
        pending.push({ target, rel: relative(WORKSPACE_ROOT, target), content });
      }

      // Phase 2: commit every file.
      for (const file of pending) {
        yield* tryTool("multi_edit", () => writeFile(file.target, file.content, "utf8"));
      }

      const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
      return `applied ${plural(edits.length, "edit")} across ${plural(pending.length, "file")}: ${pending
        .map((file) => file.rel)
        .join(", ")}`;
    }),
};
