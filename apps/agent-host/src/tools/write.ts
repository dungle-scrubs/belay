import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { ToolExecutionError } from "./errors";
import { msg } from "./shared";
import type { Tool } from "./types";

/**
 * Writes a UTF-8 file (creating parent dirs) at any path the host user can write -
 * NOT confined to the workspace, so the agent can produce artifacts anywhere (e.g.
 * an HTML file to hand to an external renderer). Relative paths resolve from the
 * host working directory; absolute paths are honored as-is.
 */
export const writeTool: Tool = {
  name: "write",
  description:
    "Write a UTF-8 text file, creating parent directories. Path may be absolute or relative to the host working directory.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, or relative to the host working directory)",
      },
      content: { type: "string", description: "Full file contents to write" },
    },
    required: ["path", "content"],
  },
  execute: (args) =>
    Effect.gen(function* () {
      const target = resolve(process.cwd(), String(args.path ?? ""));
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(target), { recursive: true }),
        catch: (cause) => new ToolExecutionError({ tool: "write", detail: msg(cause), cause }),
      });
      yield* Effect.tryPromise({
        try: () => writeFile(target, String(args.content ?? ""), "utf8"),
        catch: (cause) => new ToolExecutionError({ tool: "write", detail: msg(cause), cause }),
      });
      return `wrote ${target}`;
    }),
};
