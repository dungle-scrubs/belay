import { Effect, type Schema } from "effect";
import { msg } from "../messages";
import { type ToolError, ToolExecutionError, ToolInputError } from "./errors";
import type { Tool } from "./types";

/** Largest tool output returned to the model; anything longer is truncated. */
export const MAX_OUTPUT = 8000;

/** Directories never descended into by glob/grep. */
export const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|\.next)\//u;

/** Caps tool output at MAX_OUTPUT characters, with a truncation marker. */
export function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}

/** Wraps a thrown/rejected cause as this tool's ToolExecutionError (detail = its
 *  message). The one place the tool->error contract lives; the executor renders the
 *  failure to a single `error: …` line. */
const toolError =
  (tool: string) =>
  (cause: unknown): ToolExecutionError =>
    new ToolExecutionError({ tool, detail: msg(cause), cause });

/**
 * Runs an async tool operation (fs, child process), mapping a rejection to a
 * ToolExecutionError carrying the tool name. Tools list their operations; the error
 * wrapping lives here once, so a tool can never forget to wrap or misspell its name.
 */
export const tryTool = <A>(
  tool: string,
  op: () => Promise<A>,
): Effect.Effect<A, ToolExecutionError> => Effect.tryPromise({ try: op, catch: toolError(tool) });

/** The synchronous variant - e.g. `confine()`, which throws on a path escape. */
export const tryToolSync = <A>(tool: string, op: () => A): Effect.Effect<A, ToolExecutionError> =>
  Effect.try({ try: op, catch: toolError(tool) });

/**
 * The per-tool execution context `defineTool` hands to a tool's body, with the tool name already
 * bound so a tool never repeats (or misspells) its own name. It owns the error envelope: an async
 * op's rejection or a sync op's throw becomes this tool's ToolExecutionError, and a domain
 * validation failure becomes this tool's ToolInputError - the two error types the executor renders.
 */
export interface ToolOps {
  /** Run an async op (fs, child process); a rejection becomes this tool's ToolExecutionError. */
  attempt<A>(op: () => Promise<A>): Effect.Effect<A, ToolExecutionError>;
  /** Run a sync op that may throw (e.g. confine); a throw becomes this tool's ToolExecutionError. */
  attemptSync<A>(op: () => A): Effect.Effect<A, ToolExecutionError>;
  /** Fail with this tool's ToolInputError - a bad-argument / domain-precondition failure. */
  reject(detail: string): Effect.Effect<never, ToolInputError>;
}

/**
 * Defines a tool from its unique core: a name, description, params schema, and a body that
 * receives the decoded args and a name-bound {@link ToolOps}. The primitive owns the cross-tool
 * concerns the tools used to each re-implement: the error envelope (via ToolOps) and output
 * capping (`capped: true` truncates the result at MAX_OUTPUT for output-heavy tools - read, glob,
 * grep). Validation (schema decode) and the `error:` rendering already live in the executor; this
 * closes the loop so a tool supplies behavior, not boilerplate.
 */
export function defineTool<A>(spec: {
  readonly name: string;
  readonly description: string;
  // biome-ignore lint/suspicious/noExplicitAny: the schema's Encoded type is erased; only A matters.
  readonly params: Schema.Schema<A, any>;
  readonly readOnly?: boolean;
  /** Cap the result at MAX_OUTPUT (for tools whose output can be large). */
  readonly capped?: boolean;
  execute(args: A, ops: ToolOps): Effect.Effect<string, ToolError>;
}): Tool<A> {
  const ops: ToolOps = {
    attempt: (op) => tryTool(spec.name, op),
    attemptSync: (op) => tryToolSync(spec.name, op),
    reject: (detail) => Effect.fail(new ToolInputError({ tool: spec.name, detail })),
  };
  return {
    name: spec.name,
    description: spec.description,
    params: spec.params,
    readOnly: spec.readOnly,
    execute: (args) => {
      const result = spec.execute(args, ops);
      return spec.capped ? result.pipe(Effect.map(cap)) : result;
    },
  };
}
