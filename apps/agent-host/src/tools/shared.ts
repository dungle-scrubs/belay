import { Effect } from "effect";
import { ToolExecutionError } from "./errors";

/** Largest tool output returned to the model; anything longer is truncated. */
export const MAX_OUTPUT = 8000;

/** Directories never descended into by glob/grep. */
export const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|\.next)\//u;

/** Caps tool output at MAX_OUTPUT characters, with a truncation marker. */
export function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}

/** Normalizes an unknown thrown value to its message string. */
export function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

// Tool-argument coercers shared by the tool executors (args arrive as `unknown`).
/** A present value as a string, or undefined when the field was omitted. */
export const optStr = (value: unknown): string | undefined =>
  value === undefined ? undefined : String(value);

/** A finite number, or 0 (used for cursors/counts). */
export const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** A string array when given one, else undefined (omitted ≠ empty). */
export const strArr = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
