import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { Effect } from "effect";
import { ToolExecutionError } from "./errors";
import { msg } from "./shared";
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
      const target = yield* Effect.try({
        try: () => confine(String(args.path ?? "")),
        catch: (cause) => new ToolExecutionError({ tool: "edit", detail: msg(cause), cause }),
      });
      const content = yield* Effect.tryPromise({
        try: () => readFile(target, "utf8"),
        catch: (cause) => new ToolExecutionError({ tool: "edit", detail: msg(cause), cause }),
      });
      const occurrences = content.split(old).length - 1;
      if (occurrences === 0) {
        return "error: 'old' text not found";
      }
      if (occurrences > 1) {
        return `error: 'old' text appears ${occurrences} times (must be unique)`;
      }
      yield* Effect.tryPromise({
        try: () => writeFile(target, content.replace(old, String(args.new ?? "")), "utf8"),
        catch: (cause) => new ToolExecutionError({ tool: "edit", detail: msg(cause), cause }),
      });
      return `edited ${relative(WORKSPACE_ROOT, target)}`;
    }),
};
