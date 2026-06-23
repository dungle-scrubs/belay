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

export type ToolError = ToolExecutionError;
