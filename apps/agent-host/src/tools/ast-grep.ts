/**
 * Responsible for: the ast_grep tool - structural AST pattern search over the workspace.
 * Not for: text/regex search (grep.ts) or binary resolution (ast-grep-bin.ts).
 */
import { confine, WORKSPACE_ROOT } from "@host/boot/paths";
import { Schema } from "effect";
import { astGrepPath } from "./ast-grep-bin";
import { firstLine, runSearchProcess } from "./search-process";
import { simpleTool, toolExecution, toolInput } from "./shared";

const DEFAULT_MAX_MATCHES = 100;
const MAX_MATCHES_CAP = 500;

const Params = Schema.Struct({
  pattern: Schema.String.annotations({
    description:
      "A structural ast-grep pattern, e.g. 'console.log($$$)' or 'function $NAME($$$) { $$$ }'. $VAR is a metavariable, $$$ matches any sequence.",
  }),
  lang: Schema.optional(Schema.String).annotations({
    description:
      "Language (ts, tsx, js, jsx, python, rust, go, …). Inferred from file extensions if omitted.",
  }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Restrict the search to these workspace paths (default: the whole workspace)",
  }),
  globs: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Glob filters applied to the searched files (e.g. 'src/**/*.ts')",
  }),
  strictness: Schema.optional(
    Schema.Literal("cst", "smart", "ast", "relaxed", "signature"),
  ).annotations({ description: "Match strictness (default 'smart')" }),
  maxMatches: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: 1, maximum: MAX_MATCHES_CAP },
    }),
  ).annotations({
    description: `Cap the number of matches returned (default ${DEFAULT_MAX_MATCHES})`,
  }),
});

interface AstGrepMatch {
  readonly file?: string;
  readonly text?: string;
  readonly range?: { readonly start?: { readonly line?: number; readonly column?: number } };
}

/** Builds the `ast-grep run` argv. Argv array, never a shell string. Paths are confined to the
 *  workspace (an escape throws, surfaced as a typed error); default is the workspace root `.`. */
function buildArgs(args: typeof Params.Type): string[] {
  const argv = ["run", "--pattern", args.pattern, "--json=stream"];
  if (args.lang) argv.push("--lang", args.lang);
  if (args.strictness) argv.push("--strictness", args.strictness);
  for (const g of args.globs ?? []) argv.push("--globs", g);
  const paths = args.paths && args.paths.length > 0 ? args.paths : ["."];
  for (const p of paths) {
    confine(p); // validates the path stays in the workspace (throws on escape)
    argv.push(p);
  }
  return argv;
}

/** One match → a compact `file:line:col  snippet` row (snippet trimmed to one line, bounded). */
function formatMatch(m: AstGrepMatch): string | null {
  if (!m.file) {
    return null;
  }
  const line = m.range?.start?.line ?? 0;
  const col = m.range?.start?.column ?? 0;
  const snippet = (m.text ?? "").split("\n")[0]?.trim().slice(0, 200) ?? "";
  return `${m.file}:${line + 1}:${col + 1}  ${snippet}`;
}

/**
 * Structural (syntax-aware) code search via the project-managed ast-grep binary - read-only,
 * confined to WORKSPACE_ROOT. Unlike `grep` (text/regex), it matches on the AST, so a pattern like
 * `console.log($$$)` finds calls regardless of formatting. Wraps `ast-grep run` only (no rewrite /
 * interactive flags). Parses the `--json=stream` output into compact `file:line:col  snippet` rows.
 * An invalid pattern/language is a typed input error; a spawn/timeout failure a typed execution error.
 */
export const astGrepTool = simpleTool({
  name: "ast_grep",
  description:
    "Structural (AST-based) code search with ast-grep. Matches code by SYNTAX, not text: a pattern " +
    "like 'console.log($$$)' or 'function $NAME($$$) { $$$ }' finds matches regardless of " +
    "whitespace/formatting. $VAR is a metavariable, $$$ matches a sequence. Options: 'lang' " +
    "(ts/tsx/js/python/…), 'paths', 'globs', 'strictness', 'maxMatches'. Read-only; returns " +
    "file:line:col rows. Use 'grep' for plain text/regex search.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: async (args) => {
    const bin = astGrepPath();
    if (!bin) {
      return toolExecution("ast-grep binary is not available");
    }
    // confine() throws on a path escape; simpleTool routes that through the tool execution envelope.
    const argv = buildArgs(args);
    const result = await runSearchProcess(bin, argv, { cwd: WORKSPACE_ROOT });
    if (result.timedOut) {
      return toolExecution("search timed out");
    }
    // ast-grep exit codes: 0 = matches, 1 = no matches, >=2 = error (bad pattern/lang, spawn).
    if (result.code !== 0 && result.code !== 1) {
      const detail = firstLine(result.stderr).trim();
      // A bad pattern / unknown language is a value failure -> typed input error.
      if (/pattern|language|parse|unknown|invalid|not supported/i.test(detail)) {
        return toolInput(detail || "invalid ast-grep pattern or language");
      }
      return toolExecution(detail || "ast-grep failed");
    }
    const rows: string[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = formatMatch(JSON.parse(line) as AstGrepMatch);
        if (row) rows.push(row);
      } catch {
        // skip a non-JSON line (defensive; --json=stream emits one object per line)
      }
    }
    if (rows.length === 0) {
      return "(no matches)";
    }
    const max = Math.min(args.maxMatches ?? DEFAULT_MAX_MATCHES, MAX_MATCHES_CAP);
    return rows.length > max
      ? `${rows.slice(0, max).join("\n")}\n…[capped at ${max} matches]`
      : rows.join("\n");
  },
});
