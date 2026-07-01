import {
  type ActiveModel,
  MODEL_SELECTION_INHERITANCE,
  type PublishInput,
  planFork,
  type SessionEvent,
  selectForkPrefix,
} from "@trevor/session";

/**
 * The host FORK operation (plan 15, M2), kept PURE over injected effects so the append sequence is
 * unit-tested without a running host - `main.ts` wires the real transport read/ensure/append behind
 * {@link ForkFlowDeps}, the same shape `handoff-flow`/`workspace-switch` use.
 *
 * A fork creates a FRESH child session seeded with a copy of the parent's conversation up to a chosen
 * point ("branch from here"), entirely over the NORMAL append API - so the store/Richter stays a generic
 * append-only substrate with no fork columns. It reads the parent log, plans the fork ({@link planFork}:
 * the copied prefix followed by a trailing `session.forkedFrom` marker), ensures the child, and appends the
 * plan in order. The child is then a SELF-CONTAINED linear session; the trailing marker makes it fork-ready
 * only once the whole prefix is copied (a crash mid-copy leaves an un-marked, ignored child).
 */

/** The effects a fork orchestrates; main.ts supplies the real transport read/ensure/append. */
export interface ForkFlowDeps {
  /** Read the parent session's full event log, in seq order. */
  readSession(sessionId: string): Promise<readonly SessionEvent[]>;
  /** A fresh child session id. */
  newSessionId(): string;
  /** Create the child session in the store before any event is written to it. */
  ensureSession(sessionId: string): Promise<void>;
  /** Append one event to a session over the normal append API. */
  append(sessionId: string, input: PublishInput): Promise<void>;
}

export interface ForkResult {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly forkSeq: number;
  /** Count of copied conversation events (excludes the `session.forkedFrom` marker). */
  readonly copied: number;
  readonly forkReady: boolean;
  /**
   * The model + reasoning the child should resume its next turn on (plan 15, M4, D-002): the ACTIVE
   * post-switch selection reconstructed from the fork point, NOT a reset default. Null when the prefix
   * carries no model information (a legacy log). The provider stays stateless; only this selection is
   * inherited, so main.ts seeds the child's model selection from it.
   */
  readonly inheritedModel: ActiveModel | null;
}

/**
 * Forks `parentSessionId` at `forkSeq` into a fresh child session and returns the child id. Every write
 * goes through the injected `append`, so the operation adds no store-specific API.
 */
export async function forkSession(
  deps: ForkFlowDeps,
  args: { readonly parentSessionId: string; readonly forkSeq: number },
): Promise<ForkResult> {
  const parentEvents = await deps.readSession(args.parentSessionId);
  const childSessionId = deps.newSessionId();
  const prefix = selectForkPrefix(parentEvents, args.forkSeq);
  const plan = planFork({
    parentSessionId: args.parentSessionId,
    parentEvents,
    forkSeq: args.forkSeq,
    childSessionId,
  });
  await deps.ensureSession(childSessionId);
  for (const input of plan.events) {
    await deps.append(childSessionId, input);
  }
  return {
    childSessionId,
    parentSessionId: args.parentSessionId,
    forkSeq: args.forkSeq,
    copied: plan.copied,
    forkReady: true,
    // The model selection is the one inherited stateful participant (D-002); seed it from the fork point.
    inheritedModel: MODEL_SELECTION_INHERITANCE.inherit(prefix),
  };
}
