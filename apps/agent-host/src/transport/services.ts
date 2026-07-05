/**
 * Responsible for: the Emit service tag and the EmitEvent callback type - the seams for
 * publishing events to the Tether log.
 * Not for: the live publisher implementation - main provides it via a Layer.
 */

import type { TrevorEventInput } from "@trevor/session";
import { Context, type Effect } from "effect";

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
