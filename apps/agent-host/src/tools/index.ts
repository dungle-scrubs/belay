import { READ_ONLY_TOOL_NAMES } from "@trevor/session";
import { Effect, Either, JSONSchema, ParseResult, Schema } from "effect";
import { log, warn } from "../log";
import { supervisor } from "../processes";
import type { ToolDef } from "../providers";
import { buildSkillTool, discoverSkills } from "../skills";
import { buildTaskTools } from "../tasks";
import { askUserTool } from "./ask-user";
import { astGrepTool } from "./ast-grep";
import { astGrepPath } from "./ast-grep-bin";
import { bashTool } from "./bash";
import { doctorTool } from "./doctor";
import { editTool } from "./edit";
import { ToolInputError } from "./errors";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { multiEditTool } from "./multi-edit";
import { readTool } from "./read";
import { sessionRecallTool } from "./session-recall";
import { skillViewTool } from "./skill-view";
import { skillsListTool } from "./skills-list";
import type { Tool } from "./types";
import { webFetchTool } from "./web-fetch/web-fetch";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

export type { ToolError } from "./errors";
// The tool error classes and the `Tool`/`ToolError` contract are the package's public surface:
// tool-defining modules (processes/skills/tasks) and the executor discriminate failures by these
// tags and implement this interface. Re-exporting them here keeps `errors.ts`/`types.ts` internal
// and gives every consumer one import path (mirrors providers/index.ts).
export { ProcessError, ToolExecutionError, ToolInputError } from "./errors";
export type { Tool } from "./types";

// The TOOLS array is heterogeneous (each tool decodes to its own params type), so it holds
// `Tool<any>`; each per-tool definition stays strongly typed at its own declaration.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool params; each tool stays typed.
const FILE_TOOLS: readonly Tool<any>[] = [
  askUserTool,
  readTool,
  bashTool,
  writeTool,
  editTool,
  multiEditTool,
  globTool,
  grepTool,
  webSearchTool,
  webFetchTool,
  sessionRecallTool,
  skillsListTool,
  skillViewTool,
  doctorTool,
  supervisor.buildTool(),
  ...buildTaskTools(),
  // ast_grep is registered only when its project-managed binary resolves (skipped on a platform
  // without a prebuilt package), so the model is never offered a tool the host can't run.
  ...(astGrepPath() ? [astGrepTool] : []),
];

// Skill discovery (D-075). Two tool surfaces coexist over one registry:
//
//   - The canonical, forward path is the two-tool drill-in: `skills_list(query?, limit?)`
//     searches the compact registry METADATA, then `skill_view(skill_id)` loads exactly one
//     chosen body. Always present (they self-describe an empty registry), so non-web clients
//     and future resource types ride the same contract.
//   - The legacy `skill(name)` tool is kept as a COMPATIBILITY SHIM, added only when the
//     library is non-empty. It fuses the two levels: its description carries the ambient
//     roster (an always-on, cap-40 `skills_list()` with no query) and `skill(name)` loads one
//     body (the `skill_view(name)` step).
//
// Migration behavior: `skill(name)` is exactly `skill_view(name)` for the load, and its embedded
// roster is the no-query `skills_list()` for discovery. New clients should prefer
// `skills_list` + `skill_view`; the shim stays until ambient-roster delivery moves off the tool
// description (at which point `skill` is dropped, not re-pointed), so removing it never changes the
// canonical path - it only retires the fused alias.
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
function toParametersJsonSchema(
  // biome-ignore lint/suspicious/noExplicitAny: matches the Tool.params Encoded erasure.
  schema: Schema.Schema<unknown, any>,
): Record<string, unknown> {
  // Drop the draft `$schema` AND `$id`: both are doc-level metadata the provider never needs, and
  // `$id` is emitted as a RELATIVE URL (e.g. `/schemas/%7B%7D` for an empty struct) that
  // OpenAI-compatible providers try to resolve and reject with "relative URL without a base".
  const { $schema, $id, $defs, ...rest } = JSONSchema.make(schema) as unknown as Record<
    string,
    unknown
  >;
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
 * Names of the tools the loop may run concurrently. The classification is owned by the
 * cross-surface vocabulary in `@trevor/session` (D-031) - the single source both the host
 * and the web consume - so it can never drift between the two surfaces. A parity test
 * (index.test.ts) cross-checks this shared table against the real `TOOLS` defs, so adding a
 * host tool or flipping its `readOnly` flag without updating the table fails the build. A
 * tool absent from the read-only set is a mutating serial barrier. The loop partitions a
 * step's tool batch against this set (D-050).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = READ_ONLY_TOOL_NAMES;

/** Tool definitions advertised to the model (parameters derived from each tool's schema). */
export const TOOL_DEFS = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: toParametersJsonSchema(tool.params),
}));

/**
 * The exact tool-def set the model is OFFERED for one turn: the registry tools when tools are enabled,
 * narrowed to a subagent's allow-list (`toolNames`), plus a parent turn's delegation defs. The ONE
 * owner of this filter-then-append rule, so the turn's breakdown overhead (which SIZES the offered
 * set) can't silently diverge from what the loop actually hands the model.
 */
export function offeredToolDefs(
  useTools: boolean,
  toolNames: ReadonlySet<string> | undefined,
  delegateDefs: readonly ToolDef[] | undefined,
): readonly ToolDef[] {
  const registryTools = useTools ? TOOL_DEFS : [];
  const allowed = toolNames ? registryTools.filter((t) => toolNames.has(t.name)) : registryTools;
  return delegateDefs ? [...allowed, ...delegateDefs] : allowed;
}

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
  callId?: string,
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
  return tool.execute(decoded.right, { runId, callId }).pipe(
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
