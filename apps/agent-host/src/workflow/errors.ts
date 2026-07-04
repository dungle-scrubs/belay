/**
 * The workflow engine's typed failure vocabulary - the `E` channel the registry and (later) the
 * interpreter fail in, as `Data.TaggedError` rather than thrown `Error`s.
 *
 * Responsible for: spec-invalid, unknown-workflow, and bad-args typed errors for the authoring/
 * invocation boundary.
 * Not for: leaf-level runtime failures (leaf-failed, budget-exhausted, cancelled) - those arrive
 * with the `agent()` leaf and the concurrency primitives (M2/M3).
 */
import { Data } from "effect";

/** A WorkflowSpec failed schema decode or the static determinism check. */
export class WorkflowSpecInvalid extends Data.TaggedError("WorkflowSpecInvalid")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** A named workflow was invoked but no definition is registered under that name. */
export class WorkflowNotFound extends Data.TaggedError("WorkflowNotFound")<{
  readonly name: string;
}> {
  override get message(): string {
    return `unknown workflow "${this.name}"`;
  }
}

/** A named workflow was found but the supplied args failed its declared args schema. */
export class WorkflowArgsInvalid extends Data.TaggedError("WorkflowArgsInvalid")<{
  readonly name: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `invalid args for workflow "${this.name}": ${this.detail}`;
  }
}

/**
 * A run-level failure the structured-concurrency primitives raise in the `E` channel (M3): a
 * strict-mode batch reject (`onError:'fail'` on a leaf failure), the lifetime-cap backstop (a runaway
 * loop exceeded the total-leaf cap), or a too-large call (more items than one call may take). Distinct
 * from a per-leaf typed failure, which is a fail-soft VALUE, never thrown.
 */
export class WorkflowRunError extends Data.TaggedError("WorkflowRunError")<{
  readonly reason: "strict-failure" | "lifetime-cap" | "call-too-large";
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** The engine's authoring/invocation error vocabulary. */
export type WorkflowError = WorkflowSpecInvalid | WorkflowNotFound | WorkflowArgsInvalid;
