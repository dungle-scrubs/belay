import { rgPath } from "@vscode/ripgrep";
import { Effect, Schema } from "effect";
import { ToolExecutionError } from "./errors";
import { runSearchProcess } from "./search-process";
import { defineTool } from "./shared";
import { WORKSPACE_ROOT } from "./workspace";

const DEFAULT_MAX_MATCHES = 100;
const MAX_MATCHES_CAP = 1000;

const Params = Schema.Struct({
  pattern: Schema.String.annotations({
    description: "Regular expression (or literal text if 'literal')",
  }),
  glob: Schema.optionalWith(Schema.String, { default: () => "**/*" }).annotations({
    description: "Optional file glob to restrict the search (gitignore-style, e.g. 'src/**/*.ts')",
  }),
  literal: Schema.optional(Schema.Boolean).annotations({
    description: "Treat 'pattern' as a fixed string, not a regex",
  }),
  ignoreCase: Schema.optional(Schema.Boolean).annotations({
    description: "Case-insensitive match",
  }),
  hidden: Schema.optional(Schema.Boolean).annotations({
    description: "Also search hidden files/dirs (dotfiles)",
  }),
  noIgnore: Schema.optional(Schema.Boolean).annotations({
    description: "Do not respect .gitignore / ignore files",
  }),
  maxMatches: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: 1, maximum: MAX_MATCHES_CAP },
    }),
  ).annotations({
    description: `Cap the number of matches returned (default ${DEFAULT_MAX_MATCHES})`,
  }),
});

/** Builds the ripgrep argv from the validated params. Argv array, never a shell string, so the
 *  pattern/glob can't inject shell. Output is `path:line:text`, the same shape grep always returned. */
function buildArgs(args: typeof Params.Type): string[] {
  const argv = ["--line-number", "--no-heading", "--color=never"];
  if (args.literal) argv.push("--fixed-strings");
  if (args.ignoreCase) argv.push("--ignore-case");
  if (args.hidden) argv.push("--hidden");
  if (args.noIgnore) argv.push("--no-ignore");
  // The default '**/*' means "every file" - that's ripgrep's default, so only pass an explicit glob.
  if (args.glob && args.glob !== "**/*") argv.push("--glob", args.glob);
  // Explicit pattern + search root `.`: without a path argument ripgrep reads from stdin (which is a
  // pipe under execFile, so it would hang waiting for input); `.` makes it search the cwd instead.
  argv.push("--regexp", args.pattern, ".");
  return argv;
}

const firstLine = (text: string): string => text.split("\n").find((l) => l.trim()) ?? "";

/**
 * Searches workspace file contents with ripgrep (the project-managed `@vscode/ripgrep` binary, not a
 * system/Homebrew `rg`), confined to WORKSPACE_ROOT. Read-only. ripgrep respects .gitignore by
 * default (override with `noIgnore`), is far faster than the old Node scanner, and returns the same
 * `path:line:text` shape. An invalid regex is a typed input error; a spawn/timeout failure is a typed
 * execution error.
 */
export const grepTool = defineTool({
  name: "grep",
  description:
    "Search workspace file contents with ripgrep (respects .gitignore). Options: 'glob' to restrict " +
    "files, 'literal' for fixed-string match, 'ignoreCase', 'hidden', 'noIgnore', 'maxMatches'. " +
    "Returns path:line:text matches. For STRUCTURAL (syntax-aware) search, use ast_grep instead.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: (args, ops) =>
    Effect.gen(function* () {
      const result = yield* ops.attempt(() =>
        runSearchProcess(rgPath, buildArgs(args), { cwd: WORKSPACE_ROOT }),
      );
      if (result.timedOut) {
        return yield* Effect.fail(
          new ToolExecutionError({ tool: "grep", detail: "search timed out" }),
        );
      }
      // ripgrep exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (result.code === 1) {
        return "(no matches)";
      }
      if (result.code === 0) {
        // Searching `.` makes ripgrep prefix every path with `./`; strip it so the shape is the
        // workspace-relative `path:line:text` grep always returned.
        const lines = result.stdout
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => l.replace(/^\.\//, ""));
        const max = Math.min(args.maxMatches ?? DEFAULT_MAX_MATCHES, MAX_MATCHES_CAP);
        if (lines.length > max) {
          return `${lines.slice(0, max).join("\n")}\n…[capped at ${max} matches]`;
        }
        return lines.join("\n");
      }
      // A regex that won't parse is a value (domain) failure, surfaced as a typed input error.
      if (/regex parse error|error parsing|unrecognized/i.test(result.stderr)) {
        return yield* ops.reject(`invalid regular expression: ${firstLine(result.stderr)}`);
      }
      return yield* Effect.fail(
        new ToolExecutionError({
          tool: "grep",
          detail: firstLine(result.stderr) || "search failed",
        }),
      );
    }),
});
