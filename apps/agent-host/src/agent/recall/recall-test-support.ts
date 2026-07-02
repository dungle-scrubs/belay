import type { RecallRecord, RecallSessionRef } from "./types";

/**
 * Test fixtures for the recall record model, shared by the recall search/neighborhood/distill tests
 * so they stop re-spelling the six-field `RecallRecord` defaults (a `user` record, 1-wide range,
 * null run/tool/fold). Not a `*.test.ts`, so vitest never runs it; nothing in production imports it.
 *
 * Responsible for: shared RecallRecord / RecallSessionRef fixtures for the recall unit tests.
 */

/** A `RecallSessionRef` fixture: a sibling session; `over` sets sessionId/label/project/origin. */
export function recallSessionRef(over?: Partial<RecallSessionRef>): RecallSessionRef {
  return {
    sessionId: "sib",
    label: "session",
    project: "p",
    origin: "sibling-session",
    ...over,
  };
}

/**
 * A `RecallRecord` fixture at `seq`: a `user` record from `recallSessionRef()`, a 1-wide range, and
 * null run/tool/fold ids. `over` sets any field a test cares about (a different `kind`+`tool`/`foldId`,
 * a folded `range`, a specific `session` or `text`). The `id` defaults to `${session}#${seq}`.
 */
export function recallRecord(seq: number, over?: Partial<RecallRecord>): RecallRecord {
  const session = over?.session ?? recallSessionRef();
  return {
    id: `${session.sessionId}#${seq}`,
    session,
    seq,
    range: { fromSeq: seq, toSeq: seq },
    kind: "user",
    runId: null,
    tool: null,
    foldId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    text: `record ${seq}`,
    ...over,
  };
}
