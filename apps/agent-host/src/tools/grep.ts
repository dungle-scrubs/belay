import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { ToolInputError } from "./errors";
import { cap, SKIP_DIRS, tryTool } from "./shared";
import type { Tool } from "./types";
import { WORKSPACE_ROOT } from "./workspace";

const MAX_GREP_FILES = 2000;
const MAX_GREP_MATCHES = 100;

const Params = Schema.Struct({
  pattern: Schema.String.annotations({ description: "JavaScript regular expression" }),
  glob: Schema.optionalWith(Schema.String, { default: () => "**/*" }).annotations({
    description: "Optional file glob to search (default '**/*')",
  }),
});

/** Searches workspace file contents for a regex, returning path:line matches. */
export const grepTool: Tool<typeof Params.Type> = {
  name: "grep",
  description:
    "Search workspace file contents for a JS regular expression. Optionally restrict files with 'glob' (default '**/*'). Returns path:line:text matches.",
  params: Params,
  execute: (args) =>
    Effect.gen(function* () {
      let regex: RegExp;

      try {
        regex = new RegExp(args.pattern);
      } catch {
        // The pattern is a syntactically valid string but not a valid regex - a value
        // (domain) failure, surfaced as a typed input error.
        return yield* Effect.fail(
          new ToolInputError({ tool: "grep", detail: "invalid regular expression" }),
        );
      }

      const fileGlob = args.glob;

      return yield* tryTool("grep", async () => {
        const results: string[] = [];

        let scanned = 0;

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

        return cap(results.length > 0 ? results.join("\n") : "(no matches)");
      });
    }),
};
