import type { ArtifactRef } from "@trevor/session";
import { usePrevious } from "ahooks";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { foldSteer, type QueuedPrompt, sendQueueReducer } from "@/send-queue";

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
  readonly queue: readonly QueuedPrompt[];
  /** Enqueue a fresh prompt to publish when idle (the drain effect handles publishing). */
  readonly submit: (prompt: QueuedPrompt) => void;
  /** Hard steer: fold the queue + draft + artifacts into one prompt that replaces the queue. */
  readonly steer: (
    draft: string,
    attachments: readonly ArtifactRef[],
    meta: { readonly id: string; readonly provider: string; readonly reasoning?: string },
  ) => void;
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
  ) => Promise<void>;
  /** Changes when the browser switches durable sessions; queued prompts must not cross sessions. */
  readonly resetKey?: string | null;
}): UseSendQueue {
  const [queue, dispatchQueue] = useReducer(sendQueueReducer, [] as QueuedPrompt[]);
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
    dispatchQueue({ type: "clear" });
  }, [resetKey]);

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
    dispatchQueue({ type: "drainHead" });
    void publish(next.text, next.provider, next.reasoning, next.artifacts);
  }, [busy, queue, publish]);

  const submit = useCallback((prompt: QueuedPrompt) => {
    dispatchQueue({ type: "enqueue", prompt });
  }, []);

  const steer = useCallback(
    (
      draft: string,
      attachments: readonly ArtifactRef[],
      meta: { readonly id: string; readonly provider: string; readonly reasoning?: string },
    ) => {
      // Fold the queued prompts + draft + every queued/attached artifact into ONE steering
      // prompt (foldSteer keeps the images the user lined up rather than dropping them).
      const steered = foldSteer(queue, draft, attachments, meta);
      dispatchQueue({ type: "steer", prompt: steered });
    },
    [queue],
  );

  return { queue, submit, steer };
}
