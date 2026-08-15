import {
  type PublishInput,
  planFork,
  planTangent,
  type SessionEvent,
  seedTangentPrompt,
} from "@belay/session";
import { describe, expect, it } from "vitest";
import { buildHistory } from "./history-projection";
import { tangentIsolationReport } from "./tangent-isolation";

/**
 * M2 prompt-isolation contract (plan 37): a tangent turn's prompt is assembled from the tangent's OWN log
 * plus the seeded selection only - never the parent transcript. The proof drives the REAL host projection
 * (buildHistory) over a tangent log and the parent log, and contrasts a tangent (planTangent, no copy)
 * with a fork (planFork, copies the parent prefix) so "a tangent is not a fork" holds in prompt assembly.
 */

function ev(
  sessionId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    sessionId,
    seq,
    eventId: `${sessionId}-e${seq}`,
    type,
    producerId: "belay-web",
    payload,
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

/** Stamps a plan's PublishInput into a durable-log SessionEvent for `sessionId` at `seq`. */
function stamp(sessionId: string, seq: number, input: PublishInput): SessionEvent {
  return {
    sessionId,
    seq,
    eventId: `${sessionId}-e${seq}`,
    type: input.type,
    producerId: input.producerId,
    payload: input.payload ?? {},
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

const PARENT_SESSION = "parent";
// A parent conversation whose later turns the tangent must NOT inherit.
const PARENT: SessionEvent[] = [
  ev(PARENT_SESSION, 1, "user.message", { text: "explain the blob store", provider: "lmstudio" }),
  ev(PARENT_SESSION, 2, "assistant.completed", {
    runId: "r1",
    text: "blobs are content-addressed by sha256",
  }),
  ev(PARENT_SESSION, 3, "user.message", { text: "and the session log?", provider: "lmstudio" }),
  ev(PARENT_SESSION, 4, "assistant.completed", {
    runId: "r2",
    text: "the session log is the source of truth - secret parent conclusion",
  }),
];

// The user selected the assistant's line at message e2; that snapshot seeds the tangent.
const QUOTE = "blobs are content-addressed by sha256";
const SOURCE_MESSAGE_ID = "parent-e2";

/** A tangent's own log: the lineage marker, the seeded first prompt, then a couple of tangent turns. */
function tangentLog(): SessionEvent[] {
  const plan = planTangent({
    anchor: { parentSessionId: PARENT_SESSION, sourceMessageId: SOURCE_MESSAGE_ID, quote: QUOTE },
    tangentSessionId: "tangent",
  });
  return [
    ...plan.events.map((input, i) => stamp("tangent", i + 1, input)),
    ev("tangent", 2, "user.message", {
      text: seedTangentPrompt(QUOTE, "why sha256 and not a uuid?"),
      provider: "lmstudio",
    }),
    ev("tangent", 3, "assistant.completed", {
      runId: "tr1",
      text: "because content-addressing dedupes identical bytes",
    }),
    ev("tangent", 4, "user.message", { text: "what about hash collisions?", provider: "lmstudio" }),
  ];
}

describe("tangent prompt isolation (M2)", () => {
  it("the tangent prompt carries the seed but NONE of the parent's later transcript", () => {
    const tangent = tangentLog();
    const prompt = buildHistory(tangent);
    const text = prompt.map((m) => m.content).join("\n");

    // The seeded selection opens the tangent...
    expect(text).toContain("why sha256 and not a uuid?");
    expect(text).toContain(QUOTE);
    // ...but the parent's OTHER turns never enter the tangent's prompt.
    expect(text).not.toContain("and the session log?");
    expect(text).not.toContain("secret parent conclusion");
  });

  it("the isolation report confirms exclusion, ignoring the legitimately-seeded quote", () => {
    const report = tangentIsolationReport({
      tangentEvents: tangentLog(),
      parentEvents: PARENT,
      parentSessionId: PARENT_SESSION,
      seedQuote: seedTangentPrompt(QUOTE, "why sha256 and not a uuid?"),
    });

    expect(report.isolated).toBe(true);
    expect(report.leakedFromParent).toEqual([]);
    expect(report.forkCopiedEvents).toBe(0);
    expect(report.parentSessionEvents).toBe(0);
    // The parent's own prompt is non-trivial, so the exclusion above is meaningful, not vacuous.
    expect(report.parentPromptMessages).toBe(4);
  });

  it("a FORK is NOT isolated - it replays the parent prefix (a tangent is not a fork)", () => {
    const fork = planFork({
      parentSessionId: PARENT_SESSION,
      parentEvents: PARENT,
      forkSeq: 4,
      childSessionId: "fork",
    });
    const forkEvents = fork.events.map((input, i) => stamp("fork", i + 1, input));

    const report = tangentIsolationReport({
      tangentEvents: forkEvents,
      parentEvents: PARENT,
      parentSessionId: PARENT_SESSION,
    });

    expect(report.isolated).toBe(false);
    // The fork copied the parent's turns, so its "prompt" leaks the parent history a tangent hides.
    expect(report.leakedFromParent).toContain(
      "the session log is the source of truth - secret parent conclusion",
    );
    expect(report.leakedFromParent).toContain("and the session log?");
    expect(report.forkCopiedEvents).toBeGreaterThan(0);
  });

  it("a stray fork-copied event smuggled into a tangent log is flagged", () => {
    const smuggled: SessionEvent = ev("tangent", 5, "assistant.completed", {
      runId: "leak",
      text: "secret parent conclusion",
      _forkOrigin: { sessionId: PARENT_SESSION, seq: 4 },
    });
    const report = tangentIsolationReport({
      tangentEvents: [...tangentLog(), smuggled],
      parentEvents: PARENT,
      parentSessionId: PARENT_SESSION,
      seedQuote: QUOTE,
    });

    expect(report.forkCopiedEvents).toBe(1);
    expect(report.isolated).toBe(false);
  });
});
