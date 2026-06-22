import { readFile } from "node:fs/promises";
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
  async execute(args) {
    const path = String(args.path ?? "");
    try {
      return cap(await readFile(path, "utf8"));
    } catch (error) {
      return `error: ${msg(error)}`;
    }
  },
};
