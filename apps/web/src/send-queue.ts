import {
  type ArtifactRef,
  decodeTrevorEvent,
  isControlProducer,
  type ModelRef,
  type PastePayload,
  queuedFollowUps,
  type SessionEvent,
} from "@trevor/session";

/**
 * The browser's view of the DURABLE follow-up queue + the hard-steer fold (plan 47). A prompt submitted
 * while a turn runs is no longer withheld in browser state - it is published to the durable log at
 * submit time and the HOST owns scheduling (the host drains the backlog in order). So this module no
 * longer runs a drain state machine; it only:
 *   - projects the still-queued follow-ups out of the log ({@link queuedPromptsFrom}), each carrying its
 *     durable `eventId` as its id (the id a supersede references), so the panel + Escape-fold + unqueue
 *     all operate on the append-only log rather than private browser state;
 *   - folds the queued prompts (+ optionally the draft) into ONE steering prompt text (`combineQueued`/
 *     `combineSteer`), which the Escape-fold publishes as a single `user.message` replacement alongside
 *     a `user.supersede` retracting the folded prompts.
 */

/** The publishable user turn payload shared by session actions and the local send queue. */
export interface UserTurnInput {
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
}

/**
 * A prompt waiting in the local send queue, carrying the provider/reasoning chosen when
 * it was submitted so a model switch while it waits does not rewrite it. `id` is a stable
 * React key (queue order can change when ESC-steer collapses the queue).
 */
export interface QueuedPrompt extends UserTurnInput {
  readonly id: string;
}

/**
 * The target session's first prompt from `/handoff` is written as a runnable control-lane
 * `user.message` before the target host can claim it with `assistant.started`. The host scheduler must
 * still see that prompt, but the browser queue panel must not duplicate it beside the transcript's first
 * user row during that startup window.
 */
function initialHandoffPromptIds(
  events: readonly SessionEvent[],
  selfProducerId: string | undefined,
): Set<string> {
  const hidden = new Set<string>();
  const pendingPrompts: string[] = [];
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "handoff.accepted") {
      pendingPrompts.push(decoded.prompt);
      continue;
    }
    if (decoded.type !== "user.message" || !isControlProducer(event.producerId, selfProducerId)) {
      continue;
    }
    const index = pendingPrompts.indexOf(decoded.text);
    if (index !== -1) {
      hidden.add(event.eventId);
      pendingPrompts.splice(index, 1);
    }
  }
  return hidden;
}

/**
 * Projects the still-queued follow-ups out of the durable log (plan 47 M1): every unanswered,
 * not-superseded `user.message` behind the active turn, in submit order, each carrying its durable
 * `eventId` as its `id`. That id is what the Escape-fold / unqueue / recall-pull supersede references,
 * so the browser never needs a private queue - the log is the source of truth, surviving a reload and a
 * host restart. `selfProducerId` excludes the host's own echoes.
 */
export function queuedPromptsFrom(
  events: readonly SessionEvent[],
  selfProducerId?: string,
): QueuedPrompt[] {
  const hiddenInitialHandoffPrompts = initialHandoffPromptIds(events, selfProducerId);
  return queuedFollowUps(events, selfProducerId)
    .filter((event) => !hiddenInitialHandoffPrompts.has(event.eventId))
    .map((event) => {
      const decoded = decodeTrevorEvent(event);
      const message = decoded?.type === "user.message" ? decoded : null;
      return {
        id: event.eventId,
        text: message?.text ?? "",
        provider: message?.provider ?? "",
        ...(message?.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message?.model ? { model: message.model } : {}),
        ...(message?.artifacts?.length ? { artifacts: message.artifacts } : {}),
        ...(message?.pastes?.length ? { pastes: message.pastes } : {}),
      };
    });
}

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
