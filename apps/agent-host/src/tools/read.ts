import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { cap, tryTool } from "./shared";
import type { Tool } from "./types";

const Params = Schema.Struct({
  path: Schema.String.annotations({ description: "Path to the file" }),
});

/** Reads a UTF-8 text file relative to the host's working directory. */
export const readTool: Tool<typeof Params.Type> = {
  name: "read",
  description: "Read a UTF-8 text file and return its contents.",
  params: Params,
  readOnly: true,
  execute: (args) => tryTool("read", () => readFile(args.path, "utf8")).pipe(Effect.map(cap)),
};
