import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { Effect } from "effect";
import { contextRegistry } from "../context/registry";
import type { ToolError } from "./errors";
import { applyUniqueReplacement, replaceMissMessage } from "./replace";
import type { ToolOps } from "./shared";
import { confine, WORKSPACE_ROOT } from "./workspace";

/** A file read + edited in memory but not yet written: where it lives and its new content. */
export interface PreparedEdit {
  readonly target: string;
  readonly rel: string;
  readonly content: string;
}

/**
 * Confines `path` to the workspace, reads it, and applies each {old,new} replacement in order in
 * memory - returning the new content, resolved target, and workspace-relative path, WITHOUT
 * writing. Writing stays with the caller so multi_edit can prepare every file before any write
 * (all-or-nothing: a later miss leaves no file changed). A path escape or read failure becomes the
 * tool's ToolExecutionError (via `ops`); a replacement miss becomes a ToolInputError carrying the
 * shared miss wording (with an optional `where` suffix, e.g. " in src/x.ts"), stripped of its
 * leading `error: ` so the executor's own prefix isn't doubled. This is the confine -> read ->
 * replace -> error-envelope path edit and multi_edit share; the unique-match rule itself stays in
 * replace.ts.
 */
export function prepareEdit(
  ops: ToolOps,
  path: string,
  edits: readonly { readonly old: string; readonly new: string }[],
  where = "",
): Effect.Effect<PreparedEdit, ToolError> {
  return Effect.gen(function* () {
    // confine throws on a path escape; readFile rejects - both become the tool's ToolExecutionError.
    const target = yield* ops.attemptSync(() => confine(path));
    // Lazy below-cwd AGENTS.md (D-080): editing a file pulls in its subtree's directory-scoped context.
    yield* Effect.sync(() => contextRegistry.noteFileAccess(target));
    let content = yield* ops.attempt(() => readFile(target, "utf8"));
    for (const edit of edits) {
      const result = applyUniqueReplacement(content, edit.old, edit.new);
      if (!result.ok) {
        const detail = replaceMissMessage(result, where).replace(/^error:\s*/u, "");
        return yield* ops.reject(detail);
      }
      content = result.content;
    }
    return { target, rel: relative(WORKSPACE_ROOT, target), content };
  });
}
