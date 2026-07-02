import { events, type TrevorEventInput } from "@trevor/session";
import { FiberRef } from "effect";
import type { AdmissionStatusUpdate } from "./runtime";
import type { LocalAdmissionContext } from "./service";

/**
 * The per-turn admission bridge (plan 11 M7): a fiber-local reporter that connects the local provider's
 * admission acquire (deep in the turn's Effect) back to the turn's identity + event stream. `publishTurn`
 * sets it for the turn's fiber (priority + run id + an emitter); the LM Studio provider reads it off the
 * fiber when it acquires a generation lease, so a queued turn emits a `admission.status` event attributed
 * to the right run - WITHOUT threading per-turn arguments through the fixed `Provider.stream` signature.
 * Off-turn (no local work) the ref is null and the provider acquires with its default context.
 *
 * Responsible for: the fiber-local AdmissionTurnRef reporter and mapping runtime status updates to
 * admission.status protocol events.
 */

/** The per-turn admission context + status emitter, carried on the turn's fiber. */
export interface AdmissionTurnReporter {
  readonly context: LocalAdmissionContext;
  /** Invoked on each admission status transition for this turn (the host emits the protocol event). */
  readonly onStatus: (status: AdmissionStatusUpdate) => void;
}

/** The fiber-local reporter, null when no turn is in flight on this fiber. Set via `FiberRef.set` (or
 *  `Effect.locally`) in `publishTurn`; read via `FiberRef.get` in the provider's stream acquire. */
export const AdmissionTurnRef = FiberRef.unsafeMake<AdmissionTurnReporter | null>(null);

/** Maps a runtime admission status update to the `admission.status` protocol event for a run, omitting
 *  the queue position / refusal class except on the phase that carries them. */
export function admissionStatusEvent(
  runId: string,
  status: AdmissionStatusUpdate,
): TrevorEventInput {
  return events.admissionStatus({
    runId,
    phase: status.phase,
    provider: status.provider,
    model: status.model,
    priority: status.priority,
    ...(status.phase === "queued" ? { position: status.position } : {}),
    ...(status.phase === "refused" ? { refusal: status.refusal } : {}),
  });
}
