/**
 * Responsible for: the multi_edit tool - ordered, all-or-nothing exact-substring edits
 * across one or more workspace files.
 * Not for: the single-edit case (edit.ts) or the match rule (replace.ts).
 */
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { type PreparedEdit, readAndPrepareEdit } from "./edit-core";
import { simpleTool, toolExecution, toolInput } from "./shared";

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
 * applies everything in memory first, then writes - so a single failed
 * edit leaves no file changed.
 */
export const multiEditTool = simpleTool({
  name: "multi_edit",
  description:
    "Apply several exact-substring replacements atomically across one or more workspace files. " +
    "Edits apply in order (later edits see earlier ones); each 'old' must appear exactly once in " +
    "its file at that point. All-or-nothing: if any edit fails, no file is written. Confined to the workspace.",
  params: Params,
  execute: async (args) => {
    const edits = args.edits;
    if (edits.length === 0) {
      return toolInput("'edits' must be a non-empty array");
    }

    // The schema guarantees each edit has string path/old/new; validate the value-level
    // preconditions (non-empty path and old) the old code checked.
    for (const edit of edits) {
      if (!edit.path) {
        return toolInput("each edit needs a 'path'");
      }
      if (edit.old === "") {
        return toolInput(`'old' must be non-empty (${edit.path})`);
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

    // Phase 1: confine + read + apply each file's edits in memory. Any miss aborts here,
    // before a single write, so the workspace is never left half-edited.
    const pending: PreparedEdit[] = [];
    for (const path of order) {
      const prepared = await readAndPrepareEdit(path, byPath.get(path) ?? [], ` in ${path}`);
      if ("error" in prepared) {
        return prepared.error.kind === "input"
          ? toolInput(prepared.error.detail)
          : toolExecution(prepared.error.detail);
      }
      pending.push(prepared);
    }

    // Phase 2: commit every file.
    for (const file of pending) {
      await writeFile(file.target, file.content, "utf8");
    }

    const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
    return `applied ${plural(edits.length, "edit")} across ${plural(pending.length, "file")}: ${pending
      .map((file) => file.rel)
      .join(", ")}`;
  },
});
