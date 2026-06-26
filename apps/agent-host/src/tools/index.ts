import { Effect, Either, JSONSchema, ParseResult, Schema } from "effect";
import { log, warn } from "../log";
import { buildProcessTool } from "../processes";
import { buildSkillTool, discoverSkills } from "../skills";
import { buildTaskTools } from "../tasks";
import { astGrepTool } from "./ast-grep";
import { astGrepPath } from "./ast-grep-bin";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { ToolInputError } from "./errors";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { multiEditTool } from "./multi-edit";
import { readTool } from "./read";
import type { Tool } from "./types";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

// The TOOLS array is heterogeneous (each tool decodes to its own params type), so it holds
// `Tool<any>`; each per-tool definition stays strongly typed at its own declaration.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool params; each tool stays typed.
const FILE_TOOLS: readonly Tool<any>[] = [
  readTool,
  bashTool,
  writeTool,
  editTool,
  multiEditTool,
  globTool,
  grepTool,
  webSearchTool,
  buildProcessTool(),
  ...buildTaskTools(),
  // ast_grep is registered only when its project-managed binary resolves (skipped on a platform
  // without a prebuilt package), so the model is never offered a tool the host can't run.
  ...(astGrepPath() ? [astGrepTool] : []),
];

// The skill tool is added only when the library is non-empty, so an empty skills
// dir advertises nothing. Its description carries the skill inventory (level-1
// progressive disclosure); skill(name) loads one body on demand (level 2).
const discoveredSkills = discoverSkills();
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool params; each tool stays typed.
const TOOLS: readonly Tool<any>[] = discoveredSkills.length
  ? [...FILE_TOOLS, buildSkillTool(discoveredSkills)]
  : FILE_TOOLS;

/**
 * Derives the provider-facing JSON Schema for a tool's parameters from its Effect Schema.
 * `JSONSchema.make` returns a draft-07 doc with a top-level `$schema` key (dropped here);
 * every tool's params schema is kept FLAT (inline primitives/arrays, no cross-references)
 * so the doc never carries a `$defs` block. The result is the plain
 * `{ type: "object", properties, required }` object the provider casts to a typebox schema
 * (providers/pi-ai.ts `toPiAiTools`).
 */
export function toParametersJsonSchema(
  // biome-ignore lint/suspicious/noExplicitAny: matches the Tool.params Encoded erasure.
  schema: Schema.Schema<unknown, any>,
): Record<string, unknown> {
  const { $schema, $defs, ...rest } = JSONSchema.make(schema) as unknown as Record<string, unknown>;
  if ($defs) {
    // Every params schema is flat by construction; a $defs means a cross-reference slipped
    // in (e.g. a bare Schema.Int) and the provider would receive an unusable $ref. Inline it.
    throw new Error(
      `tool parameter schema produced a $defs block (must stay flat): ${JSON.stringify($defs)}`,
    );
  }
  return rest;
}

/**
 * Names of the tools the loop may run concurrently, derived by filtering `TOOLS` on the
 * `readOnly` flag - never a hardcoded list, so a new read-only tool joins the set just by
 * declaring `readOnly: true`. A tool that leaves the flag unset is a mutating serial barrier
 * and is absent here. The loop partitions a step's tool batch against this set (D-050).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(
  TOOLS.filter((tool) => tool.readOnly).map((tool) => tool.name),
);

/** Tool definitions advertised to the model (parameters derived from each tool's schema). */
export const TOOL_DEFS = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: toParametersJsonSchema(tool.params),
}));

/**
 * Executes a tool by name with a raw JSON argument string, as an Effect that never
 * fails: a tool's typed ToolError is rendered to an `error:` result the model can read -
 * one bad tool call must not collapse the whole turn - and attributed to that tool in
 * the host log. `runId` (the turn's correlation id) only tags the boundary log.
 *
 * The raw arguments are decoded once here against the tool's schema; a decode failure is a
 * ToolInputError carrying the formatted reason, rendered through the same `error:` path.
 */
export function executeTool(
  name: string,
  argumentsJson: string,
  runId?: string,
): Effect.Effect<string> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return Effect.succeed(`error: unknown tool "${name}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson || "{}");
  } catch {
    return Effect.succeed("error: tool arguments were not valid JSON");
  }
  const decoded = Schema.decodeUnknownEither(tool.params)(parsed);
  if (Either.isLeft(decoded)) {
    const detail = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
    return renderFailure(name, new ToolInputError({ tool: name, detail }), runId, Date.now());
  }
  const startedAt = Date.now();
  return tool.execute(decoded.right).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        log("tool", "executed", { run: runId, name, ms: Date.now() - startedAt, ok: true }),
      ),
    ),
    Effect.catchAll((error) => renderFailure(name, error, runId, startedAt)),
  );
}

/** Renders a tool failure to one model-facing `error: …` line and logs it. */
function renderFailure(
  name: string,
  error: { readonly message: string },
  runId: string | undefined,
  startedAt: number,
): Effect.Effect<string> {
  return Effect.sync(() => {
    warn("tool", "failed", {
      run: runId,
      name,
      ms: Date.now() - startedAt,
      error: error.message,
    });
    return `error: ${name} failed - ${error.message}`;
  });
}
