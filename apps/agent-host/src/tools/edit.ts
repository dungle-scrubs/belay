/**
 * Responsible for: the edit tool - one unique exact-substring replacement in a workspace file.
 * Not for: batched edits (multi-edit.ts) or the match rule itself (replace.ts).
 */
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { readAndPrepareEdit } from "./edit-core";
import { simpleTool, toolExecution, toolInput } from "./shared";
import { resolveWorkspaceRoot } from "./workspace";

const Params = Schema.Struct({
  path: Schema.String.annotations({ description: "File path within the workspace" }),
  old: Schema.String.annotations({
    description: "Exact text to replace (must be unique in the file)",
  }),
  new: Schema.String.annotations({ description: "Replacement text" }),
});

/** Replaces a unique exact substring in a workspace file (like an apply-patch). */
export const editTool = simpleTool({
  name: "edit",
  description:
    "Replace an exact substring in a workspace file. 'old' must appear exactly once. Confined to the workspace.",
  params: Params,
  execute: async (args, ctx) => {
    if (args.old === "") {
      return toolInput("'old' must be non-empty");
    }
    // The single-file, single-edit case of the multi_edit core: confine -> read -> replace, against
    // the leaf's workspace root (its worktree for an isolated leaf), else the global root. M6.
    const prepared = await readAndPrepareEdit(
      args.path,
      [{ old: args.old, new: args.new }],
      "",
      resolveWorkspaceRoot(ctx),
    );
    if ("error" in prepared) {
      return prepared.error.kind === "input"
        ? toolInput(prepared.error.detail)
        : toolExecution(prepared.error.detail);
    }
    await writeFile(prepared.target, prepared.content, "utf8");
    return `edited ${prepared.rel}`;
  },
});
