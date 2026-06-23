import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { ToolExecutionError } from "./errors";
import { cap, msg } from "./shared";
import type { Tool } from "./types";

/** Reads a UTF-8 text file relative to the host's working directory. */
export const readTool: Tool = {
  name: "read",
  description: "Read a UTF-8 text file and return its contents.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path to the file" } },
    required: ["path"],
  },
  execute: (args) =>
    Effect.tryPromise({
      try: () => readFile(String(args.path ?? ""), "utf8"),
      catch: (cause) => new ToolExecutionError({ tool: "read", detail: msg(cause), cause }),
    }).pipe(Effect.map(cap)),
};
