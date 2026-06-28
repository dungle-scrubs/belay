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
}

export type EscAction = "cancel" | "clear-draft" | "none";

/**
 * Resolves one Escape press: an open overlay wins (the transcript is left alone); otherwise Escape
 * cancels an active/awaiting run or an in-progress manual fold, else clears a non-empty draft, else
 * does nothing.
 */
export function escapeAction(s: EscState): EscAction {
  if (s.modalOpen) {
    return "none";
  }
  const hasRun = s.active !== null || s.awaiting;
  if (hasRun || s.compacting) {
    return "cancel";
  }
  if (s.draft) {
    return "clear-draft";
  }
  return "none";
}
