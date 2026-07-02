/**
 * Responsible for: the per-turn switch cell - the latest-write-wins handoff of a mid-turn
 * model/reasoning switch request into the loop's step boundary.
 * Not for: applying the switch (loop.ts) or the context-fit guard (context-guard.ts).
 */
import type { ModelRef, ModelSwitchEndpoint, ModelSwitchInitiator } from "@trevor/session";

// The initiator + endpoint shapes are the wire contract (@trevor/session); the host binds to them under
// its local names so a future field add on one side can't silently diverge from the other.
export type SwitchInitiator = ModelSwitchInitiator;
export type SwitchEndpoint = ModelSwitchEndpoint;

/**
 * A mid-turn switch request (plan 09.1): an external initiator asks the in-flight turn to change its
 * model and/or reasoning. `model` absent means a reasoning-only switch (the same provider is reused);
 * `reasoning` absent leaves the level unchanged. The loop applies it at the next step boundary, never
 * mid-stream (D-001).
 */
export interface SwitchRequest {
  /** The target model; absent for a reasoning-only switch. */
  readonly model?: ModelRef;
  /** The target reasoning level; absent leaves reasoning unchanged. */
  readonly reasoning?: string;
  readonly initiator: SwitchInitiator;
  /** The target model's context window (plan 09.1 M7): the host fills it from the catalog so the loop can
   *  run the larger->smaller fit guard. Absent when unknown - the guard then cannot fire. */
  readonly targetWindow?: number;
}

/**
 * The per-turn switch cell: the one mutable handoff between an external switch request and the turn
 * loop's step boundary (D-002). `request` is called from the host's inbound fiber when a switch control
 * event arrives; `take` is called once at each step start by `runAgent`, which clears the pending request
 * as it reads it (a switch is applied at most once). Latest-write-wins: a second request that lands before
 * the loop reads supersedes the first.
 */
export interface SwitchCell {
  request(req: SwitchRequest): void;
  /** The pending request (cleared as it is read), or undefined when none is queued. */
  take(): SwitchRequest | undefined;
}

export function createSwitchCell(): SwitchCell {
  let pending: SwitchRequest | undefined;
  return {
    request: (req) => {
      pending = req;
    },
    take: () => {
      const req = pending;
      pending = undefined;
      return req;
    },
  };
}

/** The active switchable turn marker main.ts holds between fork and fiber exit. */
export type ActiveSwitchRef = { readonly runId: string; readonly cell: SwitchCell } | null;
