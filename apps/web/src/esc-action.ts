/**
 * The single decision for what the global Escape key does, kept pure so the precedence is
 * testable without rendering the app. Escape is a catch-all `window` listener (it must work
 * regardless of focus), which means it also fires while a modal/picker/takeover is open - and
 * those overlays handle their own Escape (to close). Without the `modalOpen` guard, closing the
 * worktree/resume/command picker with Escape ALSO cancelled the in-flight turn on the transcript
 * behind it. So an open overlay owns Escape and the transcript action is suppressed.
 */
export interface EscState {
  /** The active run's id, or null when no run is active. */
  readonly active: string | null;
  /** A turn is queued/awaiting its first response (cancellable, runId not yet known). */
  readonly awaiting: boolean;
  /** A manual /compact fold is in progress (Escape aborts it). */
  readonly compacting: boolean;
  /** The composer draft (Escape clears it when there is nothing to cancel). */
  readonly draft: string;
  /** A modal, picker, or full-screen takeover is open and owns Escape. */
  readonly modalOpen: boolean;
  /** A `/handoff` draft is pending (the approval/generating surface replaces the composer); Escape
   *  dismisses it - which also escapes a host-died-mid-draft "Drafting…" that has no live host. */
  readonly handoffPending: boolean;
  /**
   * How many prompts are queued behind the in-progress work (the local send queue, excluding the
   * already-published pending row). With work in progress and a non-empty queue, the FIRST Escape
   * folds the queue into one steering prompt instead of cancelling - cancel waits for a deliberate
   * second press, by which point the flush has emptied the queue. <!-- D-001 -->
   */
  readonly queued: number;
}

export type EscAction =
  | "flush-queued-steer"
  | "cancel"
  | "clear-draft"
  | "dismiss-handoff"
  | "none";

/**
 * Resolves one Escape press. Precedence: an open overlay wins (the transcript is left alone);
 * otherwise, while work is in progress (active/awaiting run or a manual fold), queued prompts steer
 * BEFORE cancel - the first press with a non-empty queue folds it into one prompt
 * (`flush-queued-steer`), and only a press with an empty queue cancels. With nothing in progress,
 * Escape clears a non-empty draft, else does nothing. <!-- D-001 D-002 -->
 */
export function escapeAction(s: EscState): EscAction {
  if (s.modalOpen) {
    return "none";
  }
  // The handoff approval/generating surface is a composer takeover that owns Escape: dismiss it before
  // anything else (it has no live run to cancel, and a stuck draft would otherwise be unescapable).
  if (s.handoffPending) {
    return "dismiss-handoff";
  }
  const inProgress = s.active !== null || s.awaiting || s.compacting;
  if (inProgress) {
    return s.queued > 0 ? "flush-queued-steer" : "cancel";
  }
  if (s.draft) {
    return "clear-draft";
  }
  return "none";
}
