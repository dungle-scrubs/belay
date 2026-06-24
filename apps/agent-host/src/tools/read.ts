import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { cap, tryTool } from "./shared";
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
    tryTool("read", () => readFile(String(args.path ?? ""), "utf8")).pipe(Effect.map(cap)),
};
