import type { ModelRef } from "@trevor/session";

/** Who asked for a mid-turn switch: `manual` (the UI selector) now, `auto` (the future auto-router)
 *  later. The single seam both initiators attach to (plan 09.1 D-004). */
export type SwitchInitiator = "manual" | "auto";

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
