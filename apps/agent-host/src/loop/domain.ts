import type { LoopLifecycle, LoopSpec, LoopStopReason } from "@trevor/session";

/**
 * The `/loop` DOMAIN + lifecycle (plan 17, M4): a pure, side-effect-free state machine for one recurring
 * loop. It owns the legal transitions, the stop reasons, and the bounded-work rule (D-004/D-009) - and
 * NOTHING about scheduling, execution, or persistence (those are M5/M6, layered on top). Every transition
 * is a total function returning either the next state or a rejection reason, so the runtime can never drive
 * a loop into an illegal state and every rejection is explainable. The status/stop-reason vocabulary is the
 * shared {@link LoopLifecycle}/{@link LoopStopReason}.
 *
 * Responsible for: the pure loop state machine - legal transitions, stop reasons, bound rules.
 * Not for: scheduling, execution, or persistence (scheduler.ts / runner.ts / persistence.ts).
 */

/** The immutable runtime state of one loop. Transitions return a NEW state; nothing here mutates. */
export interface LoopState {
  readonly id: string;
  readonly spec: LoopSpec;
  readonly status: LoopLifecycle;
  /** Iterations completed so far (only advances while running). */
  readonly completed: number;
  /** Set once the loop leaves `running` for a terminal state. */
  readonly stopReason?: LoopStopReason;
  /** Set only for `failed`: the execution error message. */
  readonly error?: string;
}

/** A transition result: the next state, or a rejection with an explainable reason. */
export type LoopTransition =
  | { readonly ok: true; readonly state: LoopState }
  | { readonly ok: false; readonly reason: string };

/** Whether a spec carries at least one bound/cadence at all (D-004) - `until` counts as a structural bound.
 *  Note this is NOT the full activation rule: see {@link isActivatableLoop} for the runner-specific check. */
export function isBoundedLoop(spec: LoopSpec): boolean {
  return (
    spec.max !== undefined ||
    spec.everyMs !== undefined ||
    spec.until !== undefined ||
    spec.timeoutMs !== undefined
  );
}

/** A DETERMINISTIC bound the runtime can enforce on its own: a count, a cadence, or a wall-clock deadline.
 *  `until` is excluded - its satisfaction is judged per iteration by the runner, so it is not self-enforcing. */
function hasDeterministicBound(spec: LoopSpec): boolean {
  return spec.max !== undefined || spec.everyMs !== undefined || spec.timeoutMs !== undefined;
}

/**
 * Whether a spec is activatable: a non-empty action AND a bound the runtime can actually terminate on. Every
 * loop needs a bound (D-004); additionally a `process` loop bounded ONLY by `until` is rejected, because the
 * process runner cannot judge an `until` condition (only prompt/background can), so without a co-bound
 * (max/every/timeout) it would run forever. Prompt/background `until` loops are allowed (the runner signals).
 */
export function isActivatableLoop(spec: LoopSpec): boolean {
  if (spec.action.trim().length === 0 || !isBoundedLoop(spec)) {
    return false;
  }
  if (spec.runner === "process" && !hasDeterministicBound(spec)) {
    return false; // an `until`-only process loop has no enforceable stop
  }
  return true;
}

const ok = (state: LoopState): LoopTransition => ({ ok: true, state });
const reject = (reason: string): LoopTransition => ({ ok: false, reason });

/** Requires `status` to be one of `from`, else a rejection naming the illegal transition. */
function guardFrom(
  state: LoopState,
  from: readonly LoopLifecycle[],
  verb: string,
  next: () => LoopState,
): LoopTransition {
  if (!from.includes(state.status)) {
    return reject(`cannot ${verb} a ${state.status} loop`);
  }
  return ok(next());
}

/**
 * Creates a loop in `draft`. A draft that is not activatable (missing action or bound) is allowed to exist -
 * the builder shows the gaps - but {@link requestConfirmation} will refuse to advance it.
 */
export function createLoop(id: string, spec: LoopSpec): LoopState {
  return { id, spec, status: "draft", completed: 0 };
}

/** `draft` -> `pending`: ask the user to confirm. Refused when the draft is not activatable (D-004). */
export function requestConfirmation(state: LoopState): LoopTransition {
  if (state.status !== "draft") {
    return reject(`cannot confirm a ${state.status} loop`);
  }
  if (!isActivatableLoop(state.spec)) {
    if (
      state.spec.runner === "process" &&
      state.spec.until !== undefined &&
      !hasDeterministicBound(state.spec)
    ) {
      return reject(
        "a process loop bounded only by `until` cannot self-terminate (a process cannot judge the condition) - add a co-bound: max, every, or timeout",
      );
    }
    return reject("a loop needs an action and at least one of max, until, every, or timeout");
  }
  return ok({ ...state, status: "pending" });
}

/** `pending` -> `running`: the user confirmed; recurring work begins. */
export function confirmLoop(state: LoopState): LoopTransition {
  return guardFrom(state, ["pending"], "start", () => ({ ...state, status: "running" }));
}

/** `draft`/`pending` -> `deleted`: the user cancelled BEFORE any work ran. */
export function cancelLoop(state: LoopState): LoopTransition {
  return guardFrom(state, ["draft", "pending"], "cancel", () => ({ ...state, status: "deleted" }));
}

/** `running` -> `paused`. */
export function pauseLoop(state: LoopState): LoopTransition {
  return guardFrom(state, ["running"], "pause", () => ({ ...state, status: "paused" }));
}

/** `paused` -> `running`. */
export function resumeLoop(state: LoopState): LoopTransition {
  return guardFrom(state, ["paused"], "resume", () => ({ ...state, status: "running" }));
}

/** `running`/`paused` -> `stopped` (an explicit stop by the user). */
export function stopLoop(state: LoopState): LoopTransition {
  return guardFrom(state, ["running", "paused"], "stop", () => ({
    ...state,
    status: "stopped",
    stopReason: "stopped",
  }));
}

/** `running`/`paused` -> `completed` with a bound-driven reason (until satisfied, or a timeout elapsed). */
export function completeLoop(
  state: LoopState,
  reason: Extract<LoopStopReason, "until_satisfied" | "timeout" | "max_iterations">,
): LoopTransition {
  return guardFrom(state, ["running", "paused"], "complete", () => ({
    ...state,
    status: "completed",
    stopReason: reason,
  }));
}

/** `running`/`paused` -> `failed` with the error message. */
export function failLoop(state: LoopState, error: string): LoopTransition {
  return guardFrom(state, ["running", "paused"], "fail", () => ({
    ...state,
    status: "failed",
    stopReason: "error",
    error,
  }));
}

/**
 * Records one completed iteration (only while `running`). When the `max` bound is reached the loop
 * auto-completes with `max_iterations` - the runtime does not need a separate stop call.
 */
export function recordIteration(state: LoopState): LoopTransition {
  if (state.status !== "running") {
    return reject(`cannot iterate a ${state.status} loop`);
  }
  const completed = state.completed + 1;
  if (state.spec.max !== undefined && completed >= state.spec.max) {
    return ok({ ...state, completed, status: "completed", stopReason: "max_iterations" });
  }
  return ok({ ...state, completed });
}

/** Soft-deletes a loop from ANY non-deleted state (it is retained but hidden). Deleting an active loop
 *  implicitly ends it; a caller that needs a clean stop should {@link stopLoop} first. */
export function deleteLoop(state: LoopState): LoopTransition {
  if (state.status === "deleted") {
    return reject("loop is already deleted");
  }
  return ok({ ...state, status: "deleted" });
}
