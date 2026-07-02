import type { TurnStop } from "@trevor/session";

/**
 * The host-side session-lifecycle operations (D-094 M1/M5): the in-process distinction between
 * CANCEL and STOP, plus the note that KILL has no in-process form at all.
 *
 *   - CANCEL aborts the active turn and nothing else. The host stays attached, the deferred queue is
 *     untouched, and it is ready for the next prompt. This is the everyday Escape/cancel action.
 *   - STOP is graceful session shutdown: abort active work (a clean cancelled completion where the
 *     turn can still write one), clear the deferred queue so no successor answers stale prompts, and
 *     tear down background jobs - in that order. The caller then exits the process, which lapses the
 *     lease (beats stop, a standby takes over) and lets the launcher reap the ownership record.
 *   - KILL is force-termination from OUTSIDE the process (SIGKILL). It runs NONE of this - there is no
 *     orchestration to run - so the most it can do is leave an in-flight turn without a clean
 *     completion. It can never erase history.
 *
 * Crucially, none of these touch the durable log: history lives in the session-store, a separate
 * process, and nothing here has any handle to delete or rewrite it. The operations are pure over
 * injected effects so the cancel-vs-stop distinction and stop's full teardown are unit-tested without
 * a running host; `main.ts` wires the real scheduler / supervisor / transport behind them.
 *
 * Responsible for: cancel/stop teardown, termination reasons, and the auto-resume policy + cap.
 */

/** The single effect CANCEL needs: abort the active turn (publish its cancelled completion + interrupt
 *  its fiber). STOP reuses it as its first step. */
export interface CancelDeps {
  readonly abortActive: () => void;
}

/** The effects STOP orchestrates on top of CANCEL: clear the deferred queue and tear down jobs, plus
 *  the two queries that describe what was torn down (for the returned outcome). */
export interface StopDeps extends CancelDeps {
  /** Clear the deferred-prompt queue so a successor never answers stale queued prompts. */
  readonly clearQueue: () => void;
  /** Tear down the host's background jobs (dev servers, watchers). */
  readonly killJobs: () => void;
  /** Whether a turn was active when stop began (drives `cancelledActive`). */
  readonly isBusy: () => boolean;
  /** How many prompts were queued when stop began (drives `clearedQueued`). */
  readonly queuedCount: () => number;
}

/** What a stop actually tore down, for logging and the command result. */
export interface StopOutcome {
  /** True when an active turn was aborted by the stop. */
  readonly cancelledActive: boolean;
  /** How many queued prompts the stop cleared. */
  readonly clearedQueued: number;
}

/**
 * CANCEL: abort the active turn only. The host stays attached and ready for the next prompt, and the
 * deferred queue is untouched - the load-bearing difference from STOP, which also tears the session
 * down. Returns whether a turn was actually aborted is left to the caller's own state; this just runs
 * the abort.
 */
export function cancelActiveWork(deps: CancelDeps): void {
  deps.abortActive();
}

/**
 * STOP: graceful session shutdown. Aborts active work (a clean cancelled completion where the turn can
 * still write one), clears queued work, and tears down background jobs - in that order - then reports
 * what it did. The caller exits the process afterward (lapsing the lease); the durable log is never
 * touched, since nothing here can reach it. Snapshots busy/queued state BEFORE the teardown so the
 * outcome reflects what was running, not the post-teardown emptiness.
 */
export function stopSession(deps: StopDeps): StopOutcome {
  const outcome: StopOutcome = {
    cancelledActive: deps.isBusy(),
    clearedQueued: deps.queuedCount(),
  };
  deps.abortActive();
  deps.clearQueue();
  deps.killJobs();
  return outcome;
}

/** The terminal-completion fields a reason is derived from (structural - no protocol import). */
export interface CompletionOutcome {
  readonly error?: string;
  readonly cancelled: boolean;
  readonly interrupted: boolean;
  readonly noReply: boolean;
  /** Steps run when the turn hit its budget; 0 when not budget-terminated. */
  readonly stepLimit: number;
  /** The final answer text (empty/whitespace = no real reply). */
  readonly text: string;
  readonly stop?: TurnStop;
}

/**
 * Maps a terminal completion (+ whether the run overflowed) to a turn-termination reason. Precedence
 * runs hardest-stop to softest: a user cancel or host reap outranks a terminal error, which outranks a
 * budget cut, which outranks an exhausted-context overflow, which outranks a bare empty reply.
 */
export function terminationReason(c: CompletionOutcome, overflowed: boolean): string {
  if (c.stop) {
    return `${c.stop.cause}: ${c.stop.summary}`;
  }
  if (c.cancelled) return "cancelled";
  if (c.interrupted) return "interrupted";
  if (c.error) return "error";
  if (c.stepLimit > 0) return `step_limit (${c.stepLimit} steps)`;
  if (overflowed && !c.text.trim()) return "overflow";
  if (c.noReply) return "noReply";
  return "answered";
}

/**
 * Consecutive host-restart auto-resumes allowed on one turn before the host gives up and surfaces a
 * manual Resume instead. A turn killed by a restart/crash is re-issued automatically; if it keeps dying
 * (a genuinely crash-looping host) this caps the spin. The streak resets the moment the turn makes real
 * progress (a normal completion) or the user sends a fresh prompt.
 */
export const MAX_RESTART_RESUMES = 3;

/**
 * The trailing-history markers the resume bound reads, oldest-to-newest. Only the kinds that extend or
 * reset a restart-resume streak matter; the caller maps the durable log to these and drops everything
 * else (deltas, tools, the interrupt completions between resumes).
 */
export type ResumeMarker = "restart-resume" | "user-prompt" | "normal-completion";

/**
 * Counts the consecutive host-restart auto-resumes at the END of `markers`, stopping at the first
 * genuine user prompt or normal completion - the boundary that resets the streak. The caller derives
 * `markers` from the durable event log (not in-memory state), so the bound holds across host restarts:
 * a crash-loop that respawns the host each time still converges on the cap.
 */
export function countRestartResumes(markers: readonly ResumeMarker[]): number {
  let count = 0;
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    if (markers[i] !== "restart-resume") {
      break;
    }
    count += 1;
  }
  return count;
}

/** The terminal state of the most recent turn, extracted from the log by the caller, that the resume
 *  policy decides on. `continued` = a user prompt already follows this completion (so it is not the
 *  un-continued tail and must be left alone). */
export interface ResumeInputs {
  /** Closed as a host reap (restart/crash mid-turn) - the case we auto-resume. */
  readonly interrupted: boolean;
  /** Closed by a user ESC - final, never auto-resumed. */
  readonly cancelled: boolean;
  /** The completion's stop cause, if any (e.g. "step_backstop"). */
  readonly stopCause?: string;
  /** The last user prompt was itself a continuation (don't stack step-backstop continuations). */
  readonly lastWasContinuation: boolean;
  /** Consecutive host-restart resumes already spent on this turn (from {@link countRestartResumes}). */
  readonly restartResumesSpent: number;
}

/** What to do with a just-finished (or trailing) turn: resume it automatically, fall back to a manual
 *  Resume because the restart cap is spent, or leave it alone. */
export type ResumeDecision =
  | { readonly kind: "resume"; readonly cause: "step-backstop" }
  | { readonly kind: "resume"; readonly cause: "restart"; readonly attempt: number }
  | { readonly kind: "manual"; readonly cause: "restart-exhausted" }
  | { readonly kind: "none" };

/**
 * The auto-resume policy: maps a trailing turn's terminal state to whether the host re-issues a
 * continuation. A user ESC is final (never resumed). A host-restart interrupt is resumed automatically
 * up to {@link MAX_RESTART_RESUMES}, after which it asks for a manual Resume rather than risk a
 * crash-loop. A step-budget pause keeps the existing auto-continue (once, never stacked on a prior
 * continuation). Everything else - a normal answer, an overflow, a no-reply - is left alone. Pure over
 * its inputs so the firing policy and the bound are unit-tested without a running host.
 */
export function resumeAfterStop(i: ResumeInputs): ResumeDecision {
  if (i.cancelled) {
    return { kind: "none" };
  }
  if (i.interrupted) {
    return i.restartResumesSpent >= MAX_RESTART_RESUMES
      ? { kind: "manual", cause: "restart-exhausted" }
      : { kind: "resume", cause: "restart", attempt: i.restartResumesSpent + 1 };
  }
  if (i.stopCause === "step_backstop" && !i.lastWasContinuation) {
    return { kind: "resume", cause: "step-backstop" };
  }
  return { kind: "none" };
}
