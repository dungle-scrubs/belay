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

/** The engine's authoring/invocation error vocabulary. */
export type WorkflowError = WorkflowSpecInvalid | WorkflowNotFound | WorkflowArgsInvalid;
