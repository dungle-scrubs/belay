/**
 * Responsible for: the write tool - unconfined UTF-8 file writes with parent-dir creation
 * and the lazy AGENTS.md context note.
 * Not for: in-place edits - edit.ts and multi-edit.ts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contextRegistry } from "@host/project-context/registry";
import { Schema } from "effect";
import { simpleTool } from "./shared";
import { resolveCwd } from "./workspace";

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
export const writeTool = simpleTool({
  name: "write",
  description:
    "Write a UTF-8 text file, creating parent directories. Path may be absolute or relative to the host working directory.",
  params: Params,
  execute: async (args, ctx) => {
    const target = resolve(resolveCwd(ctx), args.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, args.content, "utf8");
    // Lazy below-cwd AGENTS.md (D-080): writing into a subtree pulls in its directory-scoped context.
    contextRegistry.noteFileAccess(target);
    return `wrote ${target}`;
  },
});
