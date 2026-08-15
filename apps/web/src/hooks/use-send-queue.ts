import type { SessionEvent, SupersedeReason } from "@belay/session";
import { useCallback, useMemo } from "react";
import {
  foldQueuedSteer,
  type QueuedPrompt,
  queuedPromptsFrom,
  type SteerMeta,
  type UserTurnInput,
} from "@/send-queue";

/**
 * The browser's binding onto the DURABLE follow-up queue (plan 47). The queue is no longer browser
 * state drip-fed one prompt at a time - a follow-up submitted while a turn runs is PUBLISHED to the
 * durable log immediately and the HOST owns scheduling, so this hook holds no queue of its own: it
 * derives the still-queued prompts from the event log and turns the user's queue actions into durable
 * events (publish / supersede).
 *
 * Contract:
 *   - submit(prompt): publish the follow-up now (the host defers it behind the active turn + drains the
 *     backlog in order); no busy-gating, no in-flight latch - the browser stopped being the scheduler.
 *   - flushQueuedSteer(...): the Escape-fold (D-003). Fold the queued prompts into ONE steering
 *     `user.message` and publish it, then publish a `user.supersede` retracting the folded prompts - a
 *     supersede-WITH-replacement on the append-only log.
 *   - unqueue(id): supersede-NO-replacement - drop one queued prompt without re-composing.
 *   - pullNewest(): supersede the newest queued prompt (recall) and hand its text back so the caller can
 *     pull it into the composer + the local recall ring; re-submitting re-enqueues it durably.
 */

export interface UseSendQueue {
  /** The still-queued follow-ups projected from the durable log, in submit order (each id = eventId). */
  readonly queue: readonly QueuedPrompt[];
  /** Publish a fresh prompt now; the host schedules it behind the active turn. */
  readonly submit: (prompt: UserTurnInput) => void;
  /**
   * First-Escape queued steer (D-003): fold ONLY the queued prompts into one `user.message`, publish it,
   * and supersede the folded prompts - so the host runs the single folded prompt after the active turn
   * instead of N queued prompts. A no-op when the queue is empty (nothing to steer).
   */
  readonly flushQueuedSteer: (meta: SteerMeta) => void;
  /** Unqueue one durable prompt (supersede-no-replacement); the host drops it from the run. */
  readonly unqueue: (id: string) => void;
  /**
   * Pull the NEWEST queued prompt back for editing (recall): supersede it (an immediate durable removal,
   * so there is no edit-vs-run race) and return it, so the caller drops its text into the composer + the
   * recall ring. Returns null when the queue is empty.
   */
  readonly pullNewest: () => QueuedPrompt | null;
}

export function useSendQueue({
  events,
  selfProducerId,
  projectedQueue,
  publish,
  supersede,
}: {
  /** The durable event log the queue is projected from (resets on session switch, so no reset hook).
   *  Only read when `projectedQueue` is absent - the live app passes the projector's precomputed queue. */
  readonly events: readonly SessionEvent[];
  /** This client's producerId, so the host's own echoes are excluded from the queue. */
  readonly selfProducerId?: string;
  /** The still-queued follow-ups already projected by the incremental transcript projector (Tier 0.2).
   *  When present the hook consumes it directly instead of re-scanning `events` on every render (which,
   *  keyed on the per-token-churning event array, re-ran `queuedPromptsFrom` on every streamed token). */
  readonly projectedQueue?: readonly QueuedPrompt[];
  readonly publish: (prompt: UserTurnInput) => Promise<void>;
  readonly supersede: (supersedes: readonly string[], reason: SupersedeReason) => Promise<void>;
}): UseSendQueue {
  const derived = useMemo(
    () => (projectedQueue ? null : queuedPromptsFrom(events, selfProducerId)),
    [projectedQueue, events, selfProducerId],
  );
  const queue = projectedQueue ?? derived ?? [];

  const submit = useCallback(
    (prompt: UserTurnInput) => {
      // Publish immediately (plan 47 M1): the host defers a mid-turn prompt behind the active turn and
      // drains the backlog in order, so the browser no longer withholds/drip-feeds follow-ups.
      void publish(prompt).catch(() => {
        // A transient transport failure: the prompt is simply not queued. The composer keeps the draft
        // path elsewhere; a hard failure surfaces via the connection status, not a silent local buffer.
      });
    },
    [publish],
  );

  const flushQueuedSteer = useCallback(
    (meta: SteerMeta) => {
      // Fold the queue into ONE steering prompt and publish it, then supersede the folded prompts
      // (D-003) - a supersede-with-replacement. A no-op when the queue is empty (nothing to fold).
      const folded = foldQueuedSteer(queue, meta);
      if (!folded) {
        return;
      }
      void publish(folded).catch(() => {});
      void supersede(
        queue.map((prompt) => prompt.id),
        "fold",
      );
    },
    [queue, publish, supersede],
  );

  const unqueue = useCallback(
    (id: string) => {
      void supersede([id], "unqueue");
    },
    [supersede],
  );

  const pullNewest = useCallback((): QueuedPrompt | null => {
    const newest = queue[queue.length - 1];
    if (!newest) {
      return null;
    }
    void supersede([newest.id], "recall");
    return newest;
  }, [queue, supersede]);

  return { queue, submit, flushQueuedSteer, unqueue, pullNewest };
}
