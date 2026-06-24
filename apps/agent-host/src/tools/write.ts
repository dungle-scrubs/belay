import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { tryTool } from "./shared";
import type { Tool } from "./types";

const Params = Schema.Struct({
  path: Schema.String.annotations({
    description: "File path (absolute, or relative to the host working directory)",
  }),
  content: Schema.String.annotations({ description: "Full file contents to write" }),
});

/**
 * Writes a UTF-8 file (creating parent dirs) at any path the host user can write -
 * NOT confined to the workspace, so the agent can produce artifacts anywhere (e.g.
 * an HTML file to hand to an external renderer). Relative paths resolve from the
 * host working directory; absolute paths are honored as-is.
 */
export const writeTool: Tool<typeof Params.Type> = {
  name: "write",
  description:
    "Write a UTF-8 text file, creating parent directories. Path may be absolute or relative to the host working directory.",
  params: Params,
  execute: (args) =>
    Effect.gen(function* () {
      const target = resolve(process.cwd(), args.path);
      yield* tryTool("write", () => mkdir(dirname(target), { recursive: true }));
      yield* tryTool("write", () => writeFile(target, args.content, "utf8"));
      return `wrote ${target}`;
    }),
};
