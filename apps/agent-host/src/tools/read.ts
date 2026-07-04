/**
 * Responsible for: the read tool - UTF-8 file reads plus the lazy directory-scoped
 * AGENTS.md context note (D-080).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contextRegistry } from "@host/project-context/registry";
import { Schema } from "effect";
import { simpleTool } from "./shared";
import { resolveCwd } from "./workspace";

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
  execute: async (args, ctx) => {
    // Resolve relative paths against the leaf's cwd (a worktree tree for an isolated leaf), else the
    // ambient cwd; an absolute path is unchanged by resolve. M6.
    const target = resolve(resolveCwd(ctx), args.path);
    const text = await readFile(target, "utf8");
    // Lazy below-cwd AGENTS.md (D-080): touching a file pulls in any directory-scoped context
    // between cwd and it, so the next model step sees those instructions.
    contextRegistry.noteFileAccess(target);
    return text;
  },
});
