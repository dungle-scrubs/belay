import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { msg } from "./shared";
import type { Tool } from "./types";
import { confine, WORKSPACE_ROOT } from "./workspace";

/** Writes a UTF-8 file (creating parent dirs), confined to the workspace. */
export const writeTool: Tool = {
  name: "write",
  description: "Write a UTF-8 text file, creating parent directories. Confined to the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path within the workspace" },
      content: { type: "string", description: "Full file contents to write" },
    },
    required: ["path", "content"],
  },
  async execute(args) {
    try {
      const target = confine(String(args.path ?? ""));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, String(args.content ?? ""), "utf8");
      return `wrote ${relative(WORKSPACE_ROOT, target) || "."}`;
    } catch (error) {
      return `error: ${msg(error)}`;
    }
  },
};
