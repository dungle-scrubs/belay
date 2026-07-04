import type { LucidAnchor, LucidReviewStatus } from "@trevor/session";

/**
 * The Lucid panel's REVIEW STATE (plan 27, M4/M6): a pure reducer over the annotation lifecycle the
 * native Trevor chrome drives - targeting -> drafting -> the composer queue -> delivery - plus the
 * version-swap and review-status lifecycle. Kept a pure module (no DOM, no React) so it is fully
 * unit-testable and can never disagree with itself across re-renders. DOM addressability
 * (anchor capture/resolution/highlight) lives in the sandboxed overlay; this owns only STATE.
 *
 * Deliberately INDEPENDENT of transcript message rendering (M4 REFACTOR): the queue, drafts, and
 * orphan tray are Lucid-panel state, never woven into the transcript fold.
 */

/** A draft annotation being composed: a captured target (anchor + addressed snippet) plus the
 *  in-progress note. A BARE draft (no note yet) is discardable on a version swap; a draft WITH a note
 *  is pending work that DEFERS the swap so the human never loses it (Lucid D-042/D-055). */
export interface LucidDraft {
  readonly anchor: LucidAnchor;
  readonly snippet: string;
  readonly note: string;
}

/** A committed-but-unsent annotation in the composer queue: located feedback the human finished
 *  composing but has not yet delivered to the agent. `orphaned` is set when a version swap's
 *  re-resolution can no longer attach its anchor. */
export interface LucidQueuedAnnotation {
  readonly annotationId: string;
  readonly anchor: LucidAnchor;
  readonly snippet: string;
  readonly note: string;
  /** The artifact version this annotation was authored against. */
  readonly version: number;
  readonly orphaned: boolean;
}

export interface LucidPanelState {
  readonly lucidId: string;
  readonly version: number;
  readonly reviewStatus: LucidReviewStatus;
  readonly draft: LucidDraft | null;
  readonly queue: readonly LucidQueuedAnnotation[];
  /** A newer artifact version that ARRIVED while pending work existed, held back rather than swapped
   *  live (so a committed card is never yanked out from under the human). Null when up to date. */
  readonly pendingVersion: number | null;
}

export function createLucidPanelState(input: {
  readonly lucidId: string;
  readonly version: number;
  readonly reviewStatus?: LucidReviewStatus;
}): LucidPanelState {
  return {
    lucidId: input.lucidId,
    version: input.version,
    reviewStatus: input.reviewStatus ?? "open",
    draft: null,
    queue: [],
    pendingVersion: null,
  };
}

/** Whether the panel holds pending work a version swap must not clobber: any committed queue item, or
 *  a draft that already has a note. A bare selection (targeted, no note) does NOT count. */
export function hasPendingWork(state: LucidPanelState): boolean {
  return state.queue.length > 0 || (state.draft !== null && state.draft.note.trim().length > 0);
}

/** Starts (or replaces) the composer draft from a fresh target captured in the overlay. Replacing a
 *  BARE draft is fine; a draft with a note is preserved by the caller gating on it if desired. */
export function targetLucidElement(
  state: LucidPanelState,
  target: { readonly anchor: LucidAnchor; readonly snippet: string },
): LucidPanelState {
  return { ...state, draft: { anchor: target.anchor, snippet: target.snippet, note: "" } };
}

/** Edits the in-progress draft note (no-op when there is no draft). */
export function editLucidDraftNote(state: LucidPanelState, note: string): LucidPanelState {
  if (!state.draft) {
    return state;
  }
  return { ...state, draft: { ...state.draft, note } };
}

/** Discards the current draft (Escape / cancel). */
export function discardLucidDraft(state: LucidPanelState): LucidPanelState {
  return state.draft ? { ...state, draft: null } : state;
}

/**
 * Commits the current draft into the composer queue under `annotationId` (a caller-minted stable id).
 * A note-less draft is rejected (returns state unchanged) so an empty annotation never queues.
 */
export function commitLucidDraft(state: LucidPanelState, annotationId: string): LucidPanelState {
  const draft = state.draft;
  if (!draft?.note.trim()) {
    return state;
  }
  const queued: LucidQueuedAnnotation = {
    annotationId,
    anchor: draft.anchor,
    snippet: draft.snippet,
    note: draft.note,
    version: state.version,
    orphaned: false,
  };
  return { ...state, draft: null, queue: [...state.queue, queued] };
}

/** Removes a queued annotation (the human deletes a composed card, or dismisses an orphan). */
export function removeLucidQueued(state: LucidPanelState, annotationId: string): LucidPanelState {
  const queue = state.queue.filter((q) => q.annotationId !== annotationId);
  return queue.length === state.queue.length ? state : { ...state, queue };
}

/** The queued annotations that are ready to deliver (non-orphaned). */
export function deliverableLucidAnnotations(
  state: LucidPanelState,
): readonly LucidQueuedAnnotation[] {
  return state.queue.filter((q) => !q.orphaned);
}

/** Clears the composer queue after a successful delivery to the agent. */
export function clearLucidQueue(state: LucidPanelState): LucidPanelState {
  return state.queue.length === 0 ? state : { ...state, queue: [] };
}

/** The orphan tray: queued annotations whose anchor no longer resolves after a version swap. */
export function orphanedLucidAnnotations(state: LucidPanelState): readonly LucidQueuedAnnotation[] {
  return state.queue.filter((q) => q.orphaned);
}

/**
 * A new artifact version ARRIVED (M6). With pending work, the swap is DEFERRED (held in
 * `pendingVersion`) so a committed composer card is never yanked mid-compose; otherwise it swaps live
 * immediately, dropping a stale BARE draft (its anchor was against the prior snapshot). A lower/equal
 * version is ignored (stale republish / replay).
 */
export function lucidVersionArrived(state: LucidPanelState, version: number): LucidPanelState {
  if (version <= state.version) {
    return state;
  }
  if (hasPendingWork(state)) {
    return { ...state, pendingVersion: version };
  }
  return { ...state, version, pendingVersion: null, draft: null };
}

/**
 * Applies a deferred version swap the human accepted (M6): moves to `pendingVersion` (or the given
 * one), drops any bare draft, and marks the queued annotations the overlay could no longer re-resolve
 * as orphaned (moved into the orphan tray) rather than floating them at a stale offset.
 */
export function applyLucidVersion(
  state: LucidPanelState,
  version: number,
  orphanedIds: readonly string[],
): LucidPanelState {
  const orphaned = new Set(orphanedIds);
  return {
    ...state,
    version,
    pendingVersion: null,
    draft: state.draft?.note.trim() ? state.draft : null,
    queue: state.queue.map((q) => (orphaned.has(q.annotationId) ? { ...q, orphaned: true } : q)),
  };
}

/** Sets the review lifecycle status (resolved on approve, open on reopen). */
export function setLucidReviewStatus(
  state: LucidPanelState,
  reviewStatus: LucidReviewStatus,
): LucidPanelState {
  return state.reviewStatus === reviewStatus ? state : { ...state, reviewStatus };
}
