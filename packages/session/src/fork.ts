import type { SessionEvent } from "./event";
import { PRODUCER_IDS } from "./identity";
import { events } from "./protocol";
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
 */

/** A message/event's stable coordinate in its home session. */
export interface MessageOrigin {
  readonly sessionId: string;
  readonly seq: number;
}

/** The reserved payload key a forked (copied) event carries to record its source. It is namespaced with a
 *  leading underscore so it cannot collide with a real event field; the store treats it as opaque payload. */
export const FORK_ORIGIN_KEY = "_forkOrigin";

/**
 * The durable conversation-state event types a fork copies: exactly what replay consumes to rebuild history
 * (`user.message`, `assistant.completed`, `tool.started`, `tool.completed`) plus the model / context /
 * task state a resumed turn needs (`model.switched`, `context.compacted`, `tasks.current`). Session-local
 * control (session.*, handoff.*, delegated.to), transport/presence (host.*), and ephemeral streaming
 * (assistant.delta/thinking/…) are deliberately EXCLUDED, so a fork is a clean linear session, not a
 * replay of the parent's UI churn. An allow-list is the safe default: a new event type is not copied until
 * it is explicitly known to carry forkable state.
 */
export const FORKABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.message",
  "assistant.completed",
  "tool.started",
  "tool.completed",
  "model.switched",
  "context.compacted",
  "tasks.current",
]);

/** Whether an event type is copied into a fork prefix (see {@link FORKABLE_EVENT_TYPES}). */
export function isForkableEvent(type: string): boolean {
  return FORKABLE_EVENT_TYPES.has(type);
}

/**
 * The stable per-message id of an event in its home session: `${sessionId}:${seq}`. `seq` is dense and
 * never reassigned once appended, so this is reproducible - unlike the store-minted `eventId`, which a fork
 * COPY reassigns. Use this (or {@link MessageOrigin}) to reference a fork point or dedupe an inherited row.
 */
export function messageId(event: Pick<SessionEvent, "sessionId" | "seq">): string {
  return `${event.sessionId}:${event.seq}`;
}

/** Reads the fork-origin tag off an event's payload, or null for a native (non-copied) event. */
export function forkOriginOf(event: Pick<SessionEvent, "payload">): MessageOrigin | null {
  const raw = event.payload[FORK_ORIGIN_KEY];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.sessionId === "string" && typeof o.seq === "number") {
      return { sessionId: o.sessionId, seq: o.seq };
    }
  }
  return null;
}

/** Selects the forkable conversation prefix up to AND INCLUDING `forkSeq`, in seq order. */
export function selectForkPrefix(events: readonly SessionEvent[], forkSeq: number): SessionEvent[] {
  return events.filter((e) => e.seq <= forkSeq && isForkableEvent(e.type));
}

/**
 * Builds the seed {@link PublishInput}s for a fresh child session from a parent prefix. Each forkable event
 * at or before `forkSeq` becomes a PublishInput that keeps its type/producer/payload and gains a
 * {@link FORK_ORIGIN_KEY} tag pointing at the IMMEDIATE parent's `(sessionId, seq)` - a re-fork overwrites
 * any inherited tag, so lineage stays a chain of single-parent links. The caller appends these to a new
 * session via the normal append API; the child is then a self-contained linear session.
 */
export function buildForkPrefix(args: {
  readonly parentSessionId: string;
  readonly parentEvents: readonly SessionEvent[];
  readonly forkSeq: number;
}): PublishInput[] {
  return selectForkPrefix(args.parentEvents, args.forkSeq).map((event) => ({
    type: event.type,
    producerId: event.producerId,
    payload: {
      ...event.payload,
      [FORK_ORIGIN_KEY]: { sessionId: args.parentSessionId, seq: event.seq },
    },
  }));
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
}

/**
 * Plans a fork as a list of appends over the NORMAL session API - no store-specific fork operation. The
 * copied prefix comes FIRST, then a single `session.forkedFrom` marker LAST: appending the lineage record
 * only after the whole prefix is copied means its presence signals a COMPLETE fork (a crash mid-copy leaves
 * a child with no marker, which a resumer ignores) - so the marker doubles as the fork-ready signal.
 */
export function planFork(args: {
  readonly parentSessionId: string;
  readonly parentEvents: readonly SessionEvent[];
  readonly forkSeq: number;
  readonly childSessionId: string;
}): ForkPlan {
  const seeds = buildForkPrefix({
    parentSessionId: args.parentSessionId,
    parentEvents: args.parentEvents,
    forkSeq: args.forkSeq,
  });
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
