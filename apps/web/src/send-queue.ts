import type { ArtifactRef, ModelRef, PastePayload } from "@trevor/session";

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
  /** The selected model reference (D-065), snapshotted at submit time alongside provider/reasoning so
   *  a model switch while the prompt waits does not rewrite it. Carried to the host's user.message. */
  readonly model?: ModelRef;
  readonly artifacts?: readonly ArtifactRef[];
  /** Exact pasted-text payloads paired to the prompt's `[Pasted text #N +M lines]` tokens, in reading
   *  order. Carried so a queued prompt's hidden payloads survive the wait and ride to the host. */
  readonly pastes?: readonly PastePayload[];
};

/**
 * Folds queued prompts (in order) and the current draft into one steering prompt text.
 * Cancelling collapses everything the user has lined up into a single interruption,
 * rather than replaying queued prompts one at a time after the steer.
 */
export function combineSteer(queue: readonly QueuedPrompt[], draft: string): string {
  return [...queue.map((q) => q.text), draft.trim()].filter(Boolean).join("\n\n");
}

/**
 * Folds ONLY the queued prompts into one steering prompt text, one trimmed line per prompt
 * (empties dropped, no blank-line gaps). This is the queue-only fold for the first-Escape
 * steer (D-001/D-003): the active composer draft is deliberately NOT mixed in, and prompts join
 * with a single `\n` so the steer reads as one prompt per queued line, not paragraph blocks.
 */
export function combineQueued(queue: readonly QueuedPrompt[]): string {
  return queue
    .map((q) => q.text.trim())
    .filter(Boolean)
    .join("\n");
}

/** The active selection snapshot a steer stamps onto its folded prompt (the same fields submit carries). */
export type SteerMeta = {
  readonly id: string;
  readonly provider: string;
  readonly reasoning?: string;
  readonly model?: ModelRef;
};

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
 * (so a steer keeps the images the user lined up). The queued + draft pasted payloads are
 * gathered in the SAME reading order as the folded text (queue prompts first, then the
 * draft), so each surviving `[Pasted text #N]` token still maps to its payload. Returns null
 * when there is nothing to steer - no text and no artifacts - so the queue is simply cleared.
 */
export function foldSteer(
  queue: readonly QueuedPrompt[],
  draft: string,
  attachments: readonly ArtifactRef[],
  draftPastes: readonly PastePayload[],
  meta: SteerMeta,
): QueuedPrompt | null {
  const text = combineSteer(queue, draft);
  const artifacts = [...queue.flatMap((q) => q.artifacts ?? []), ...attachments];
  const pastes = [...queue.flatMap((q) => q.pastes ?? []), ...draftPastes];
  if (!text && artifacts.length === 0) {
    return null;
  }
  return {
    id: meta.id,
    text,
    provider: meta.provider,
    reasoning: meta.reasoning,
    ...(meta.model ? { model: meta.model } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(pastes.length ? { pastes } : {}),
  };
}

/**
 * Builds the single steering prompt that collapses the queue on the first Escape (D-001): the
 * queued texts folded one-per-line (`combineQueued`) and the queued artifacts gathered into one
 * list, stamped with the current selection (`meta`). Unlike `foldSteer` this is queue-only - it
 * ignores the draft and the composer attachments, which keep their own behavior. Returns null when
 * the queue carries no text and no artifacts, so there is nothing to steer.
 */
export function foldQueuedSteer(
  queue: readonly QueuedPrompt[],
  meta: SteerMeta,
): QueuedPrompt | null {
  const text = combineQueued(queue);
  const artifacts = queue.flatMap((q) => q.artifacts ?? []);
  const pastes = queue.flatMap((q) => q.pastes ?? []);
  if (!text && artifacts.length === 0) {
    return null;
  }
  return {
    id: meta.id,
    text,
    provider: meta.provider,
    reasoning: meta.reasoning,
    ...(meta.model ? { model: meta.model } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(pastes.length ? { pastes } : {}),
  };
}
