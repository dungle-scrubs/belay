import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { defineTool } from "./shared";

const Params = Schema.Struct({
  path: Schema.String.annotations({ description: "Path to the file" }),
});

/** Reads a UTF-8 text file relative to the host's working directory. */
export const readTool = defineTool({
  name: "read",
  description: "Read a UTF-8 text file and return its contents.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: (args, ops) => ops.attempt(() => readFile(args.path, "utf8")),
});
