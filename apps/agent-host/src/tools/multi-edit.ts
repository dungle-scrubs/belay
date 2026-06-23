import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { Effect } from "effect";
import { ToolExecutionError } from "./errors";
import { msg } from "./shared";
import type { Tool } from "./types";
import { confine, WORKSPACE_ROOT } from "./workspace";

interface MultiEditItem {
  path: string;
  old: string;
  new: string;
}

/**
 * Applies several exact-substring replacements atomically - many edits to one file
 * and/or edits across multiple files. Edits run in order (later edits see earlier
 * ones); each `old` must be unique in that file at the point it applies. Reads and
 * applies everything in memory first, then writes - so a single failed edit leaves
 * no file changed.
 */
export const multiEditTool: Tool = {
  name: "multi_edit",
  description:
    "Apply several exact-substring replacements atomically across one or more workspace files. " +
    "Edits apply in order (later edits see earlier ones); each 'old' must appear exactly once in " +
    "its file at that point. All-or-nothing: if any edit fails, no file is written. Confined to the workspace.",
  parameters: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        description: "Edits applied in order. Repeat a path to make several edits to one file.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path within the workspace" },
            old: { type: "string", description: "Exact text to replace (unique in the file here)" },
            new: { type: "string", description: "Replacement text" },
          },
          required: ["path", "old", "new"],
        },
      },
    },
    required: ["edits"],
  },
  execute: (args) =>
    Effect.gen(function* () {
      const rawEdits = Array.isArray(args.edits) ? args.edits : [];
      if (rawEdits.length === 0) {
        return "error: 'edits' must be a non-empty array";
      }

      // Normalize + validate the edit list up front.
      const edits: MultiEditItem[] = [];
      for (const raw of rawEdits) {
        const item = (raw ?? {}) as Record<string, unknown>;
        const path = String(item.path ?? "");
        const old = String(item.old ?? "");
        if (!path) {
          return "error: each edit needs a 'path'";
        }
        if (old === "") {
          return `error: 'old' must be non-empty (${path})`;
        }
        edits.push({ path, old, new: String(item.new ?? "") });
      }

      // Group by path, preserving first-seen order.
      const order: string[] = [];
      const byPath = new Map<string, MultiEditItem[]>();
      for (const edit of edits) {
        const list = byPath.get(edit.path);
        if (list) {
          list.push(edit);
        } else {
          byPath.set(edit.path, [edit]);
          order.push(edit.path);
        }
      }

      // Phase 1: read each file and apply its edits in memory. Any miss aborts here,
      // before a single write, so the workspace is never left half-edited.
      const pending: { target: string; rel: string; content: string }[] = [];
      for (const path of order) {
        const target = yield* Effect.try({
          try: () => confine(path),
          catch: (cause) =>
            new ToolExecutionError({ tool: "multi_edit", detail: msg(cause), cause }),
        });
        let content = yield* Effect.tryPromise({
          try: () => readFile(target, "utf8"),
          catch: (cause) =>
            new ToolExecutionError({ tool: "multi_edit", detail: msg(cause), cause }),
        });
        for (const edit of byPath.get(path) ?? []) {
          const occurrences = content.split(edit.old).length - 1;
          if (occurrences === 0) {
            return `error: 'old' text not found in ${path}`;
          }
          if (occurrences > 1) {
            return `error: 'old' text appears ${occurrences} times in ${path} (must be unique)`;
          }
          content = content.replace(edit.old, edit.new);
        }
        pending.push({ target, rel: relative(WORKSPACE_ROOT, target), content });
      }

      // Phase 2: commit every file.
      for (const file of pending) {
        yield* Effect.tryPromise({
          try: () => writeFile(file.target, file.content, "utf8"),
          catch: (cause) =>
            new ToolExecutionError({ tool: "multi_edit", detail: msg(cause), cause }),
        });
      }

      const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
      return `applied ${plural(edits.length, "edit")} across ${plural(pending.length, "file")}: ${pending
        .map((file) => file.rel)
        .join(", ")}`;
    }),
};
