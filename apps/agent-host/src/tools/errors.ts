import { Data } from "effect";

/**
 * What a tool can fail with. A tool either succeeds with the string the model reads, or
 * fails with one of these in the Effect `E` channel; the executor renders the failure to
 * a single `error: …` line (and logs it), so individual tools no longer carry try/catch.
 */

/** An operation a tool delegated to (fs, child process, a registry) threw. */
export class ToolExecutionError extends Data.TaggedError("ToolExecutionError")<{
  readonly tool: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

/**
 * A tool's arguments did not match its schema (or a domain precondition on the
 * arguments failed, e.g. an empty `old`/`edits`/`command`). The executor renders
 * `detail` after the `error: ${name} failed - ` prefix, so set `detail` to the
 * exact wording the old inline `return "error: …"` produced (minus that prefix).
 */
export class ToolInputError extends Data.TaggedError("ToolInputError")<{
  readonly tool: string;
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/**
 * A process-supervisor lookup failed (no such process id). The model-facing
 * rendering keeps the prior wording (`no such process "p3"`).
 */
export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export type ToolError = ToolExecutionError | ToolInputError | ProcessError;
