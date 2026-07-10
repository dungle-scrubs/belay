/**
 * Responsible for: the simpleTool builder, output capping, the bounded-text helper, the
 * one-line clip helper, the lenient numeric clamp, stream merging, the skip-dirs policy, and
 * the toolInput/toolExecution failure helpers.
 * Not for: the failure classes themselves - errors.ts.
 */
import { msg } from "@host/transport/messages";
import { Effect, type Schema } from "effect";
import { type ToolError, ToolExecutionError, ToolInputError } from "./errors";
import type { Tool, ToolContext } from "./types";

/** Largest tool output returned to the model; anything longer is truncated. */
export const MAX_OUTPUT = 8000;

/** The marker appended when output is truncated (single owner; mcp/content.ts bounds with it too). */
export const TRUNCATION_NOTICE = "\n…[truncated]";

/** Directories never descended into by glob/grep. */
export const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|\.next)\//u;

/** Caps tool output at MAX_OUTPUT characters, with a truncation marker. */
export function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}${TRUNCATION_NOTICE}` : text;
}

export interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

/** Bounds text at `maxChars` with the shared truncation marker, flagging the cut. The one
 *  implementation behind mcp/content's boundText and lsp/caps's capText. */
export function boundedText(text: string, maxChars: number): BoundedText {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return { text: `${text.slice(0, maxChars)}${TRUNCATION_NOTICE}`, truncated: true };
}

/** Collapses `text` onto one line (whitespace runs become single spaces) and cuts it at
 *  `maxChars` with an ellipsis. The shared one-line preview: list lines (tools/mcp) and copy
 *  confirmations (tools/clip) pass their own limits. */
export function clipLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** Clamps a lenient numeric arg into [floor, ceiling], falling back when absent/non-finite. Shared
 *  by the tools whose schemas advertise bounded integer caps but decode leniently (docs, web_fetch). */
export function clamp(
  value: number | undefined,
  floor: number,
  ceiling: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), floor), ceiling);
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
 * Defines a simple tool whose body is its core logic: return a string (or a Promise of one),
 * throw/reject for operational failures, and call `toolInput` / `toolExecution` for known domain or
 * execution failures. A body over an Effect-native service instead returns its
 * `Effect<string, ToolError>` directly - it stays in the Effect graph (no `runPromise` round-trip)
 * and owns its typed failures. The builder owns the tool-name error envelope for the throwing
 * paths, and output capping for all of them.
 */
export function simpleTool<A>(spec: {
  readonly name: string;
  readonly description: string;
  // biome-ignore lint/suspicious/noExplicitAny: the schema's Encoded type is erased; only A matters.
  readonly params: Schema.Schema<A, any>;
  readonly readOnly?: boolean;
  readonly capped?: boolean;
  execute(args: A, ctx?: ToolContext): string | Promise<string> | Effect.Effect<string, ToolError>;
}): Tool<A> {
  return {
    name: spec.name,
    description: spec.description,
    params: spec.params,
    readOnly: spec.readOnly,
    execute: (args, ctx) => {
      const result = Effect.suspend(() => {
        let body: string | Promise<string> | Effect.Effect<string, ToolError>;
        try {
          body = spec.execute(args, ctx);
        } catch (cause) {
          return Effect.fail(simpleToolError(spec.name, cause));
        }
        if (Effect.isEffect(body)) {
          return body;
        }
        return Effect.tryPromise({
          try: () => Promise.resolve(body),
          catch: (cause) => simpleToolError(spec.name, cause),
        });
      });
      return spec.capped ? result.pipe(Effect.map(cap)) : result;
    },
  };
}
