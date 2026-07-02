/**
 * Responsible for: the Emit service tag - the DI seam for publishing events to the Richter log.
 * Not for: the live publisher implementation - main provides it via a Layer.
 */

import type { TrevorEventInput } from "@trevor/session";
import { Context, type Effect } from "effect";

/**
 * Publishes one trevor event to the durable Richter log. Modeled as a service (not a
 * threaded callback) so the turn pipeline declares its need to emit in its `R` channel,
 * `main` provides the live publisher via a Layer, and tests provide a collecting layer.
 * This is the dependency-injection seam between the Effect turn program and the
 * imperative Richter transport that publishes its events.
 */
export class Emit extends Context.Tag("Emit")<
  Emit,
  { readonly publish: (event: TrevorEventInput) => Effect.Effect<void> }
>() {}
