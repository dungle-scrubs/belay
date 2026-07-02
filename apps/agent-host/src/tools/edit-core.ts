import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { confine, WORKSPACE_ROOT } from "@host/boot/paths";
import { contextRegistry } from "@host/project-context/registry";
import { msg } from "@host/transport/messages";
import { applyUniqueReplacement, replaceMissMessage } from "./replace";

/** A file read + edited in memory but not yet written: where it lives and its new content. */
export interface PreparedEdit {
  readonly target: string;
  readonly rel: string;
  readonly content: string;
}

export type EditPreparationError =
  | { readonly kind: "input"; readonly detail: string }
  | { readonly kind: "execution"; readonly detail: string; readonly cause?: unknown };

export type EditPreparation = PreparedEdit | { readonly error: EditPreparationError };

/**
 * Confines `path` to the workspace, reads it, and applies each {old,new} replacement in order in
 * memory - returning the new content, resolved target, and workspace-relative path, WITHOUT
 * writing. Writing stays with the caller so multi_edit can prepare every file before any write
 * (all-or-nothing: a later miss leaves no file changed). A path escape or read failure is reported
 * as an execution error detail; a replacement miss is reported as an input error detail carrying
 * the shared miss wording (with an optional `where` suffix, e.g. " in src/x.ts"), stripped of its
 * leading `error: ` so the executor's own prefix isn't doubled. This is the confine -> read ->
 * replace path edit and multi_edit share; tool-name error envelopes stay with the tool boundary.
 */
export async function readAndPrepareEdit(
  path: string,
  edits: readonly { readonly old: string; readonly new: string }[],
  where = "",
): Promise<EditPreparation> {
  let target: string;
  try {
    target = confine(path);
  } catch (cause) {
    return { error: { kind: "execution", detail: msg(cause), cause } };
  }

  // Lazy below-cwd AGENTS.md (D-080): editing a file pulls in its subtree's directory-scoped context.
  contextRegistry.noteFileAccess(target);

  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (cause) {
    return { error: { kind: "execution", detail: msg(cause), cause } };
  }

  for (const edit of edits) {
    const result = applyUniqueReplacement(content, edit.old, edit.new);
    if (!result.ok) {
      const detail = replaceMissMessage(result, where).replace(/^error:\s*/u, "");
      return { error: { kind: "input", detail } };
    }
    content = result.content;
  }
  return { target, rel: relative(WORKSPACE_ROOT, target), content };
}
