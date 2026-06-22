import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cap, msg, SKIP_DIRS } from "./shared";
import type { Tool } from "./types";
import { WORKSPACE_ROOT } from "./workspace";

const MAX_GREP_FILES = 2000;
const MAX_GREP_MATCHES = 100;

/** Searches workspace file contents for a regex, returning path:line matches. */
export const grepTool: Tool = {
  name: "grep",
  description:
    "Search workspace file contents for a JS regular expression. Optionally restrict files with 'glob' (default '**/*'). Returns path:line:text matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression" },
      glob: { type: "string", description: "Optional file glob to search (default '**/*')" },
    },
    required: ["pattern"],
  },
  async execute(args) {
    let regex: RegExp;
    try {
      regex = new RegExp(String(args.pattern ?? ""));
    } catch {
      return "error: invalid regular expression";
    }
    const fileGlob = String(args.glob ?? "**/*");
    const results: string[] = [];
    let scanned = 0;
    try {
      for await (const entry of glob(fileGlob, { cwd: WORKSPACE_ROOT })) {
        if (SKIP_DIRS.test(`/${entry}/`) || scanned >= MAX_GREP_FILES) {
          continue;
        }
        scanned += 1;
        let content: string;
        try {
          content = await readFile(resolve(WORKSPACE_ROOT, entry), "utf8");
        } catch {
          continue; // directory, binary, or unreadable - skip
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] as string;
          if (regex.test(line)) {
            results.push(`${entry}:${i + 1}:${line.trim().slice(0, 200)}`);
            if (results.length >= MAX_GREP_MATCHES) {
              return cap(`${results.join("\n")}\n…[capped at ${MAX_GREP_MATCHES} matches]`);
            }
          }
        }
      }
    } catch (error) {
      return `error: ${msg(error)}`;
    }
    return cap(results.length > 0 ? results.join("\n") : "(no matches)");
  },
};
