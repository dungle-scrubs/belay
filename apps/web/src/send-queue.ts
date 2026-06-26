import type { ArtifactRef } from "@trevor/session";

/**
 * The browser's local send queue + hard-steer fold - the "when does my prompt go out"
 * state machine, lifted out of App.tsx so it is unit-testable without React rendering.
 * App.tsx owns the React glue (the busy/in-flight gating and the drain effect); this
 * owns the pure transitions and the fold-on-steer rule, in one place.
 *
 * The contract:
 *   - a prompt submitted while a turn is in flight is enqueued (FIFO); the head is
 *     published and dropped once the session is idle, so the host never receives two
 *     prompts at once and the event log stays cleanly paired;
 *   - a hard steer (ESC mid-turn) folds the queued prompts + the draft into ONE prompt
 *     and the queued + attached artifacts into one list, replacing the queue, so the
 *     cancelled turn is followed by a single combined interruption (not a replay).
 */

/**
 * A prompt waiting in the local send queue, carrying the provider/reasoning chosen when
 * it was submitted so a model switch while it waits does not rewrite it. `id` is a stable
 * React key (queue order can change when ESC-steer collapses the queue).
 */
export type QueuedPrompt = {
  readonly id: string;
  readonly text: string;
  readonly provider: string;
  readonly reasoning?: string;
  readonly artifacts?: readonly ArtifactRef[];
};

/**
 * Folds queued prompts (in order) and the current draft into one steering prompt text.
 * Cancelling collapses everything the user has lined up into a single interruption,
 * rather than replaying queued prompts one at a time after the steer.
 */
export function combineSteer(queue: readonly QueuedPrompt[], draft: string): string {
  return [...queue.map((q) => q.text), draft.trim()].filter(Boolean).join("\n\n");
}

export type SendQueueAction =
  | { readonly type: "clear" }
  | { readonly type: "enqueue"; readonly prompt: QueuedPrompt }
  | { readonly type: "drainHead" }
  | { readonly type: "steer"; readonly prompt: QueuedPrompt | null };

/** The send-queue transitions: enqueue (tail), drainHead (published head removed), and
 *  steer (replace the whole queue with the single folded prompt, or empty it). */
export function sendQueueReducer(
  queue: readonly QueuedPrompt[],
  action: SendQueueAction,
): QueuedPrompt[] {
  switch (action.type) {
    case "clear":
      return [];
    case "enqueue":
      return [...queue, action.prompt];
    case "drainHead":
      return queue.slice(1);
    case "steer":
      return action.prompt ? [action.prompt] : [];
  }
}

/**
 * Builds the single steering prompt that replaces the queue on a hard steer: folds the
 * queued prompts + draft into one text and the queued + attached artifacts into one list
 * (so a steer keeps the images the user lined up). Returns null when there is nothing to
 * steer - no text and no artifacts - so the queue is simply cleared.
 */
export function foldSteer(
  queue: readonly QueuedPrompt[],
  draft: string,
  attachments: readonly ArtifactRef[],
  meta: { readonly id: string; readonly provider: string; readonly reasoning?: string },
): QueuedPrompt | null {
  const text = combineSteer(queue, draft);
  const artifacts = [...queue.flatMap((q) => q.artifacts ?? []), ...attachments];
  if (!text && artifacts.length === 0) {
    return null;
  }
  return {
    id: meta.id,
    text,
    provider: meta.provider,
    reasoning: meta.reasoning,
    ...(artifacts.length ? { artifacts } : {}),
  };
}
