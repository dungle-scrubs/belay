import type { TurnStop } from "@trevor/session";

/**
 * Why a turn ended, for /doctor. New completions carry a typed stop object; legacy completions are
 * still summarized from the old flags so stored sessions remain readable without migration.
 */

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
