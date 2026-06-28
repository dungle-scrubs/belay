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
