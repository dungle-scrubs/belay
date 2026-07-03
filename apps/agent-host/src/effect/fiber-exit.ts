/**
 * Shared interpretation for cancellable Effect fibers: converts `Exit` into the small lifecycle
 * shape call sites need, and centralizes fire-and-forget interruption.
 *
 * Responsible for: mapping Effect fiber success, interruption, and failure into host lifecycle data.
 * Not for: owning fiber lifetimes, scheduler policy, or user-visible cancellation text.
 */

import { Cause, Effect, Exit, Fiber } from "effect";

export type InterpretedFiberExit<A> =
  | { readonly tag: "ok"; readonly value: A }
  | { readonly tag: "cancelled" }
  | { readonly tag: "failed"; readonly cause: string };

export function interpretFiberExit<A, E>(exit: Exit.Exit<A, E>): InterpretedFiberExit<A> {
  if (Exit.isSuccess(exit)) {
    return { tag: "ok", value: exit.value };
  }
  if (Cause.isInterruptedOnly(exit.cause)) {
    return { tag: "cancelled" };
  }
  return { tag: "failed", cause: Cause.pretty(exit.cause) };
}

export function interruptFiber<A, E>(fiber: Fiber.RuntimeFiber<A, E>): void {
  Effect.runFork(Fiber.interrupt(fiber));
}
