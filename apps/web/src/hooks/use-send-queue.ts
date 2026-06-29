import type { ArtifactRef, ModelRef, PastePayload } from "@trevor/session";
import { usePrevious } from "ahooks";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  foldQueuedSteer,
  foldSteer,
  type QueuedPrompt,
  type SteerMeta,
  sendQueueReducer,
} from "@/send-queue";

/**
 * The browser's local send-queue React state machine, lifted out of App.tsx so the
 * delicate double-send / echo-latch invariant lives in one place. The PURE transitions
 * and the fold-on-steer rule are in ./send-queue (unit-tested without React); this owns
 * only the React glue: the dispatchQueue reducer wiring, the busy/in-flight latch, and
 * the release + drain effects.
 *
 * Contract (unchanged from the inline version):
 *   - submit(prompt) enqueues (FIFO); the head is published only once the session is idle
 *     and nothing is in flight, so the host never receives two prompts at once and the
 *     event log stays cleanly paired;
 *   - steer(...) folds the queued prompts + draft + queued/attached artifacts into ONE
 *     prompt and replaces the queue, so a cancelled turn is followed by a single combined
 *     interruption (not a replay). The caller publishes the cancel; the steer publishes
 *     only once the cancel resolves the turn (busy -> idle), keeping cancel ahead of steer.
 */

export interface UseSendQueue {
  /** The prompt already POSTed to the durable log, waiting for its stream echo. */
  readonly pending: QueuedPrompt | null;
  readonly queue: readonly QueuedPrompt[];
  /** Enqueue a fresh prompt to publish when idle (the drain effect handles publishing). */
  readonly submit: (prompt: QueuedPrompt) => void;
  /** Hard steer: fold the queue + draft + artifacts + pasted payloads into one prompt. */
  readonly steer: (
    draft: string,
    attachments: readonly ArtifactRef[],
    pastes: readonly PastePayload[],
    meta: SteerMeta,
  ) => void;
  /**
   * First-Escape queued steer (D-001): fold ONLY the queued prompts into one prompt and publish it
   * now, draining the queue. The host queues a user.message that arrives mid-turn and runs it after
   * the active turn, so this collapses the queue into one steering prompt WITHOUT cancelling. A no-op
   * when the queue is empty (nothing to steer).
   */
  readonly flushQueuedSteer: (meta: SteerMeta) => void;
}

export function useSendQueue({
  busy,
  publish,
  resetKey,
}: {
  /** True while a turn is in flight (active run, or awaiting the echo). */
  readonly busy: boolean;
  readonly publish: (
    text: string,
    provider: string,
    reasoning?: string,
    artifacts?: readonly ArtifactRef[],
    model?: ModelRef,
    pastes?: readonly PastePayload[],
  ) => Promise<void>;
  /** Changes when the browser switches durable sessions; queued prompts must not cross sessions. */
  readonly resetKey?: string | null;
}): UseSendQueue {
  const [queue, dispatchQueue] = useReducer(sendQueueReducer, [] as QueuedPrompt[]);
  const [pending, setPending] = useState<QueuedPrompt | null>(null);
  // inFlight bridges the window between publishing a prompt and seeing its echo turn
  // the session busy, so the drain effect can't fire twice and double-send. prevBusy
  // catches the turn-ended edge (busy high -> low) to release the latch.
  const inFlightRef = useRef(false);
  const prevBusy = usePrevious(busy);

  useEffect(() => {
    if (resetKey === undefined) {
      return;
    }
    inFlightRef.current = false;
    setPending(null);
    dispatchQueue({ type: "clear" });
  }, [resetKey]);

  // Once the prompt echo reaches the transcript, App's busy fold turns true
  // (`awaitingResponse` or `active`). At that point the local pending row would duplicate the durable
  // user message, so drop it.
  useEffect(() => {
    if (busy) {
      setPending(null);
    }
  }, [busy]);

  // Release the in-flight latch when a turn ends (busy goes high then low), so the
  // next queued prompt becomes eligible to publish. Runs before the drain effect.
  useEffect(() => {
    if (prevBusy && !busy) {
      inFlightRef.current = false;
    }
  }, [busy, prevBusy]);

  // Drain one prompt at a time: publish the head only when idle and nothing is in
  // flight. Removing the head and latching inFlight before the echo arrives keeps a
  // re-render from publishing the next prompt early.
  useEffect(() => {
    if (busy || inFlightRef.current || queue.length === 0) {
      return;
    }
    const next = queue[0];
    if (!next) {
      return;
    }
    inFlightRef.current = true;
    setPending(next);
    dispatchQueue({ type: "drainHead" });
    void publish(
      next.text,
      next.provider,
      next.reasoning,
      next.artifacts,
      next.model,
      next.pastes,
    ).catch(() => {
      inFlightRef.current = false;
      setPending((current) => (current?.id === next.id ? null : current));
    });
  }, [busy, queue, publish]);

  const submit = useCallback((prompt: QueuedPrompt) => {
    dispatchQueue({ type: "enqueue", prompt });
  }, []);

  const steer = useCallback(
    (
      draft: string,
      attachments: readonly ArtifactRef[],
      pastes: readonly PastePayload[],
      meta: SteerMeta,
    ) => {
      // Fold the queued prompts + draft + every queued/attached artifact + pasted payload into ONE
      // steering prompt (foldSteer keeps the images AND the pastes the user lined up).
      const steered = foldSteer(queue, draft, attachments, pastes, meta);
      dispatchQueue({ type: "steer", prompt: steered });
    },
    [queue],
  );

  const flushQueuedSteer = useCallback(
    (meta: SteerMeta) => {
      // Fold ONLY the queued prompts into one steering prompt and publish it now, then drop the
      // queue. We bypass the busy-gated drain on purpose: the host's TurnScheduler queues a
      // user.message that arrives mid-turn and runs it after the active turn, so the first Escape
      // collapses the queue into one prompt WITHOUT cancelling. Draining the queue here is what lets
      // a deliberate second Escape fall through to cancel (the queue is now empty). <!-- D-001 -->
      const folded = foldQueuedSteer(queue, meta);
      if (!folded) {
        return;
      }
      dispatchQueue({ type: "clear" });
      void publish(
        folded.text,
        folded.provider,
        folded.reasoning,
        folded.artifacts,
        folded.model,
        folded.pastes,
      ).catch(() => {
        // The publish failed (transient transport error): put the folded prompt back so it is not
        // lost - it drains when the turn ends, and the queue is non-empty again for a retry.
        dispatchQueue({ type: "enqueue", prompt: folded });
      });
    },
    [queue, publish],
  );

  return { pending, queue, submit, steer, flushQueuedSteer };
}
