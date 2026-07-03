import type { SessionEvent } from "./event";
import { PRODUCER_IDS } from "./identity";
import { events } from "./protocol";
import { decodeTrevorEvent } from "./protocol-decode";
import type { PublishInput } from "./transport";

/**
 * The FORK PREFIX contract (plan 15, M1). Forking a session means starting a FRESH linear session seeded
 * with a copy of the parent's conversation up to a chosen point ("branch from here"). This module is the
 * pure core: it selects the forkable prefix, tags each copied event with where it came from, and hands back
 * the {@link PublishInput}s a caller appends to a new session through the NORMAL append API - so Richter/the
 * session store stays a generic append-only substrate with no fork-specific columns (D-002).
 *
 * A copied event keeps its type/producer/payload and gains one reserved payload key, {@link FORK_ORIGIN_KEY}
 * = `{ sessionId, seq }`, pointing at the source event in the IMMEDIATE parent. That origin (plus the child
 * session's own `session.forkedFrom`, M2) makes lineage a walkable chain of single-parent links and lets a
 * participant dedupe an inherited message by origin.
 *
 * DEFERRED (main.ts wiring): a copied `user.message` keeps its original answerable producer, so if a fork
 * point lands on a `user.message` with no trailing `assistant.completed`, the child host's turn loop will
 * re-run that pending prompt on replay. Whether a fork should auto-run that trailing turn (vs land settled
 * for the user to edit) is a live-host decision the fork WIRING must make deliberately - it is not fixed
 * here, where the copy is faithful by design.
 */

/** The reserved payload key a forked (copied) event carries to record its source. It is namespaced with a
 *  leading underscore so it cannot collide with a real event field; the store treats it as opaque payload. */
const FORK_ORIGIN_KEY = "_forkOrigin";

/**
 * The durable conversation-state event types a fork copies: exactly what replay consumes to rebuild history
 * (`user.message`, `assistant.completed`, `tool.started`, `tool.completed`) plus the `/clear` baseline
 * boundary (`user.command`) and the model / task state a resumed turn needs (`model.switched`,
 * `tasks.current`). Session-local control (session.*, handoff.*, delegated.to), transport/presence
 * (host.*), and ephemeral streaming (assistant.delta/thinking/…) are deliberately EXCLUDED, so a fork is a
 * clean linear session, not a replay of the parent's UI churn. An allow-list is the safe default.
 *
 * Two deliberate exclusions/inclusions matter:
 *  - `user.command` IS copied: replay resets the prompt baseline on a `/clear` (position-based), so
 *    dropping it would RESURRECT context the user explicitly cleared into the child's prompt.
 *  - `context.compacted` is NOT copied: its `throughSeq` is a PARENT seq, but the store re-mints dense
 *    child seqs over only the forkable subset, so a copied fold would fold the WRONG span (silently
 *    dropping recent turns). The child instead copies the full uncompacted prefix and recompacts itself.
 */
const FORKABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.message",
  "user.command",
  "assistant.completed",
  "tool.started",
  "tool.completed",
  "model.switched",
  "tasks.current",
]);

/** Whether an event type is copied into a fork prefix (see {@link FORKABLE_EVENT_TYPES}). */
function isForkableEvent(type: string): boolean {
  return FORKABLE_EVENT_TYPES.has(type);
}

/** Selects the forkable conversation prefix up to AND INCLUDING `forkSeq`, sorted by seq. The sort is
 *  defensive: callers pass seq-ordered logs, but the copy + model fold both depend on order, so a
 *  mis-ordered input would silently corrupt the child rather than fail. */
function selectForkPrefix(events: readonly SessionEvent[], forkSeq: number): SessionEvent[] {
  return events
    .filter((e) => e.seq <= forkSeq && isForkableEvent(e.type))
    .sort((a, b) => a.seq - b.seq);
}

/** Copies one event into a fork seed, tagging it with its immediate-parent origin. */
function tagWithOrigin(parentSessionId: string, event: SessionEvent): PublishInput {
  return {
    type: event.type,
    producerId: event.producerId,
    payload: {
      ...event.payload,
      [FORK_ORIGIN_KEY]: { sessionId: parentSessionId, seq: event.seq },
    },
  };
}

/** The ordered append plan for creating a forked child session (plan 15, M2). */
export interface ForkPlan {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly forkSeq: number;
  /** Events to append to the child in order: the copied prefix, THEN the `session.forkedFrom` marker. */
  readonly events: readonly PublishInput[];
  /** Count of copied conversation events (excludes the trailing `session.forkedFrom` record). */
  readonly copied: number;
  /** The active model inherited by the child at the fork point, or null when the prefix carries none. */
  readonly inheritedModel: ActiveModel | null;
}

/**
 * Plans a fork as a list of appends over the NORMAL session API - no store-specific fork operation. The
 * copied prefix comes FIRST, then a single `session.forkedFrom` marker LAST: appending the lineage record
 * only after the whole prefix is copied means its presence signals a COMPLETE fork (a crash mid-copy leaves
 * a child with no marker, which a resumer ignores) - so the marker doubles as the fork-ready signal.
 *
 * The forkable prefix is selected ONCE, copied, and folded for the child's inherited model.
 */
export function planFork(args: {
  readonly parentSessionId: string;
  readonly parentEvents: readonly SessionEvent[];
  readonly forkSeq: number;
  readonly childSessionId: string;
}): ForkPlan {
  const prefix = selectForkPrefix(args.parentEvents, args.forkSeq);
  const seeds = prefix.map((event) => tagWithOrigin(args.parentSessionId, event));
  const forkedFrom = events.sessionForkedFrom({
    parentSessionId: args.parentSessionId,
    forkSeq: args.forkSeq,
  });
  const marker: PublishInput = {
    type: forkedFrom.type,
    producerId: PRODUCER_IDS.host,
    payload: forkedFrom.payload,
  };
  return {
    childSessionId: args.childSessionId,
    parentSessionId: args.parentSessionId,
    forkSeq: args.forkSeq,
    events: [...seeds, marker],
    copied: seeds.length,
    inheritedModel: reconstructActiveModel(prefix),
  };
}

/**
 * Whether a child session's log shows a COMPLETED fork: the `session.forkedFrom` marker is present. Because
 * the marker is appended after the copied prefix, its presence means the copy finished and the child is
 * safe to resume.
 */
export function isForkReady(childEvents: readonly Pick<SessionEvent, "type">[]): boolean {
  return childEvents.some((e) => e.type === "session.forkedFrom");
}

/**
 * The active model selection at a point in a session: the SOURCE + MODEL ids the host needs to rebuild the
 * provider (`buildSourceProvider(sourceId, modelId)`), plus the reasoning level. A legacy bare-`provider`
 * turn (no structured `ModelRef`) uses the provider id for both.
 */
export interface ActiveModel {
  readonly sourceId: string;
  readonly modelId: string;
  readonly reasoning?: string;
}

/**
 * Reconstructs the ACTIVE model selection at the end of a prefix (plan 15, M4, D-002). It folds the
 * conversation in order: each `user.message` establishes the turn's selected model, and every
 * subsequently-APPLIED `model.switched` (a `blocked` switch is ignored) moves the active MODEL. The result
 * is what a fork's NEXT turn must resume on - the live post-switch selection at the fork point, NOT a reset
 * default. Returns null only when the prefix carries no model information at all (a legacy log).
 *
 * A `model.switched` endpoint carries only the model id + reasoning (not a source), so a switch keeps the
 * current active source and moves the model id + reasoning onto it - the host stays on the same provider
 * source across a mid-turn model change.
 */
function reconstructActiveModel(events: readonly SessionEvent[]): ActiveModel | null {
  const build = (sourceId: string, modelId: string, reasoning: string | undefined): ActiveModel =>
    reasoning !== undefined ? { sourceId, modelId, reasoning } : { sourceId, modelId };

  let active: ActiveModel | null = null;
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "user.message") {
      if (decoded.model) {
        // A structured ModelRef carries both ids + reasoning.
        active = build(
          decoded.model.sourceId,
          decoded.model.modelId,
          decoded.model.reasoning ?? undefined,
        );
      } else if (decoded.provider) {
        // Legacy bare-provider turn: the provider id stands in for both source + model.
        active = build(decoded.provider, decoded.provider, decoded.reasoning);
      }
    } else if (decoded.type === "model.switched" && decoded.outcome === "applied") {
      // The switch endpoint has no source; keep the active source, move the model id + reasoning.
      active = build(
        active?.sourceId ?? decoded.to.model,
        decoded.to.model,
        decoded.to.reasoning ?? active?.reasoning,
      );
    }
  }
  return active;
}
