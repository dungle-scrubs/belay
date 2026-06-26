/**
 * Why a turn ended, for /doctor (Phase 2 M4 / D-051…D-053). The host tracks the most recent turn's
 * termination reason so `/doctor` can report it: answered | step_limit | overflow | noReply |
 * cancelled | interrupted | error. The reason is derived purely from the terminal `assistant.completed`
 * flags plus whether the run hit a terminal context overflow (a separate `assistant.overflow` event,
 * since overflow is a within-turn recovery signal, not a completion flag).
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
}

/**
 * Maps a terminal completion (+ whether the run overflowed) to a turn-termination reason. Precedence
 * runs hardest-stop to softest: a user cancel or host reap outranks a terminal error, which outranks a
 * budget cut, which outranks an exhausted-context overflow, which outranks a bare empty reply.
 */
export function terminationReason(c: CompletionOutcome, overflowed: boolean): string {
  if (c.cancelled) return "cancelled";
  if (c.interrupted) return "interrupted";
  if (c.error) return "error";
  if (c.stepLimit > 0) return `step_limit (${c.stepLimit} steps)`;
  if (overflowed && !c.text.trim()) return "overflow";
  if (c.noReply) return "noReply";
  return "answered";
}
