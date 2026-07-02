import { msg } from "@host/transport/messages";
import { Effect, type Schema } from "effect";
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

/** Merges a command's stdout + stderr into one block: each side trimmed, blanks dropped, joined by a
 *  newline. Shared by the foreground shell runner, the promotable runner, and the job-snapshot tail. */
export function combineStreams(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

class SimpleToolInputFailure extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

class SimpleToolExecutionFailure extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

export function toolInput(detail: string): never {
  throw new SimpleToolInputFailure(detail);
}

export function toolExecution(detail: string): never {
  throw new SimpleToolExecutionFailure(detail);
}

function simpleToolError(tool: string, cause: unknown): ToolError {
  if (cause instanceof SimpleToolInputFailure) {
    return new ToolInputError({ tool, detail: cause.detail });
  }
  if (cause instanceof SimpleToolExecutionFailure) {
    return new ToolExecutionError({ tool, detail: cause.detail });
  }
  if (cause instanceof ToolInputError || cause instanceof ToolExecutionError) {
    return cause;
  }
  return new ToolExecutionError({ tool, detail: msg(cause), cause });
}

/**
 * Defines a simple tool whose body is its core logic: return a string, throw/reject for operational
 * failures, and call `toolInput` / `toolExecution` for known domain or execution failures. The
 * builder owns the tool-name error envelope and output capping, so ordinary tools do not thread
 * shared execution helpers through their implementation.
 */
export function simpleTool<A>(spec: {
  readonly name: string;
  readonly description: string;
  // biome-ignore lint/suspicious/noExplicitAny: the schema's Encoded type is erased; only A matters.
  readonly params: Schema.Schema<A, any>;
  readonly readOnly?: boolean;
  readonly capped?: boolean;
  execute(args: A): string | Promise<string>;
}): Tool<A> {
  return {
    name: spec.name,
    description: spec.description,
    params: spec.params,
    readOnly: spec.readOnly,
    execute: (args) => {
      const result = Effect.tryPromise({
        try: () => Promise.resolve(spec.execute(args)),
        catch: (cause) => simpleToolError(spec.name, cause),
      });
      return spec.capped ? result.pipe(Effect.map(cap)) : result;
    },
  };
}
