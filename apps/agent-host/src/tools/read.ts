import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { contextRegistry } from "../context/registry";
import { simpleTool } from "./shared";

const Params = Schema.Struct({
  path: Schema.String.annotations({ description: "Path to the file" }),
});

/** Reads a UTF-8 text file relative to the host's working directory. */
export const readTool = simpleTool({
  name: "read",
  description: "Read a UTF-8 text file and return its contents.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: async (args) => {
    const text = await readFile(args.path, "utf8");
    // Lazy below-cwd AGENTS.md (D-080): touching a file pulls in any directory-scoped context
    // between cwd and it, so the next model step sees those instructions.
    contextRegistry.noteFileAccess(resolve(process.cwd(), args.path));
    return text;
  },
});
