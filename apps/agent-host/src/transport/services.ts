/**
 * Responsible for: the Emit service tag, the EmitEvent callback type, and the live publisher Layer -
 * the seams for publishing events to the Tether log.
 */

import type { TrevorEventInput } from "@trevor/session";
import { Context, Effect, Layer } from "effect";

/** Publishes one host-authored event to the durable log - the shape of main.ts's `emit`, threaded
 *  into the command/factory modules as a plain async callback (the imperative sibling of {@link Emit}). */
export type EmitEvent = (event: TrevorEventInput) => Promise<void>;

/**
 * Publishes one trevor event to the durable Tether log. Modeled as a service (not a
 * threaded callback) so the turn pipeline declares its need to emit in its `R` channel,
 * `main` provides the live publisher via a Layer, and tests provide a collecting layer.
 * This is the dependency-injection seam between the Effect turn program and the
 * imperative Tether transport that publishes its events.
 */
export class Emit extends Context.Tag("Emit")<
  Emit,
  { readonly publish: (event: TrevorEventInput) => Effect.Effect<void> }
>() {}

/**
 * The live Emit Layer both the main session and each adopted tangent publish through: turn events go
 * to the durable log via `emit`, and a second `assistant.completed` for an already-completed run (the
 * fiber's onExit racing an immediate cancel) is dropped via `markCompleted`. Shared so the dedup
 * discipline has exactly one definition instead of drifting copies per session.
 */
export function emitLiveLayer(
  emit: EmitEvent,
  markCompleted: (runId: string) => boolean,
): Layer.Layer<Emit> {
  return Layer.succeed(Emit, {
    publish: (event) =>
      Effect.promise(() => {
        if (event.type === "assistant.completed") {
          const runId = typeof event.payload.runId === "string" ? event.payload.runId : "";
          if (runId && !markCompleted(runId)) {
            return Promise.resolve();
          }
        }
        return emit(event);
      }),
  });
}
