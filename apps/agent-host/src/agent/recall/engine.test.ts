import assert from "node:assert/strict";
import { events, type SessionEvent, type TrevorEventInput } from "@trevor/session";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { Provider, ProviderError, ProviderEvent } from "../../providers";
import { ProviderUnavailable } from "../../providers";
import { type RecallDeps, runRecall, type SiblingRead } from "./engine";

/**
 * D-044 M3/M4: the orchestrator's typed outcomes (ok / no_hits / partial / unavailable /
 * invalid_filters / error) and the end-to-end path through a fake reader + fake provider. This is
 * where the load-bearing recall behaviors are pinned: compacted-away current detail is searched
 * but the active-prompt tail is not, sibling sessions are searched, and unreadable sessions ride
 * back as diagnostics.
 */

let seq = 0;
function ev(input: TrevorEventInput, sessionId: string, producerId = "trevor-web"): SessionEvent {
  const n = seq++;
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    eventId: `e${n}`,
    payload: input.payload,
    producerId,
    seq: n,
    sessionId,
    type: input.type,
  };
}

function fakeProvider(text: string, fail = false): Provider {
  const reasoningLevels = ["off"];
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels,
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels,
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (): Stream.Stream<ProviderEvent, ProviderError> =>
      fail
        ? Stream.fail(new ProviderUnavailable({ provider: "fake", detail: "down" }))
        : Stream.fromIterable<ProviderEvent>([{ type: "text", text }]),
  };
}

/** A deps builder: current session (with fold) + sibling read + provider, each overridable. */
function deps(over: Partial<RecallDeps> & { siblingRead?: SiblingRead } = {}): RecallDeps {
  return {
    current:
      over.current ??
      (() => ({
        sessionId: "cur",
        label: "current",
        project: "proj",
        events: [],
        foldThroughSeq: null,
      })),
    siblings:
      over.siblings ??
      (() => Promise.resolve(over.siblingRead ?? { sessions: [], diagnostics: [] })),
    provider: over.provider ?? (() => fakeProvider("answer [S1]")),
  };
}

test("runRecall finds compacted-away current detail, distills, and cites a source", async () => {
  seq = 0;
  // Current session: seqs 0-1 folded away (throughSeq 2), seq 4 still in the active prompt.
  const currentEvents = [
    ev(
      events.userMessage({ text: "what database did we pick for recall", provider: "qwen" }),
      "cur",
    ),
    ev(
      events.assistantCompleted({ runId: "r1", text: "we picked SQLite for the durable log" }),
      "cur",
      "trevor-host",
    ),
    ev(
      events.contextCompacted({
        foldId: "f1",
        throughSeq: 2,
        summary: "discussed storage",
        manifest: { turnRange: { fromSeq: 0, toSeq: 1 }, files: [], tools: [], topics: [] },
        tokensBefore: 9000,
        tokensAfter: 4000,
        model: "qwen",
      }),
      "cur",
      "trevor-host",
    ),
    {
      ...ev(events.userMessage({ text: "active prompt tail", provider: "qwen" }), "cur"),
      seq: 5,
    } as SessionEvent,
  ];

  const result = await runRecall(
    deps({
      current: () => ({
        sessionId: "cur",
        label: "current",
        project: "proj",
        events: currentEvents,
        foldThroughSeq: 2,
      }),
    }),
    { query: "which database did we pick" },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.ok(finding);
  assert.ok(finding.citations.length >= 1, "the finding cites a stable record id");
  assert.ok(result.sources.length >= 1);
  assert.ok(result.activity.searchedRecords >= 1);
});

test("runRecall searches sibling project sessions", async () => {
  seq = 0;
  const siblingEvents = [
    ev(
      events.userMessage({ text: "how do we throttle the lease heartbeat", provider: "qwen" }),
      "sib",
    ),
    ev(
      events.assistantCompleted({ runId: "r1", text: "the lease heartbeat is every 500ms" }),
      "sib",
      "trevor-host",
    ),
  ];

  const result = await runRecall(
    deps({
      siblingRead: {
        sessions: [
          {
            session: {
              sessionId: "sib",
              label: "older work",
              project: "proj",
              origin: "sibling-session",
            },
            events: siblingEvents,
          },
        ],
        diagnostics: [],
      },
    }),
    { query: "lease heartbeat throttle" },
  );

  assert.equal(result.status, "ok");
  const [source] = result.sources;
  assert.ok(source);
  assert.equal(source.sessionId, "sib", "a sibling session is a recall source");
  assert.equal(source.origin, "sibling-session");
});

test("runRecall reports unavailable when there is no corpus at all", async () => {
  const result = await runRecall(deps(), { query: "anything" });
  assert.equal(result.status, "unavailable", "no fold + no siblings = nothing to recall");
  assert.equal(result.findings.length, 0);
});

test("runRecall reports no_hits when the corpus has nothing matching", async () => {
  seq = 0;
  const siblingEvents = [
    ev(events.userMessage({ text: "totally unrelated chit chat", provider: "qwen" }), "sib"),
  ];
  const result = await runRecall(
    deps({
      siblingRead: {
        sessions: [
          {
            session: {
              sessionId: "sib",
              label: "older",
              project: "proj",
              origin: "sibling-session",
            },
            events: siblingEvents,
          },
        ],
        diagnostics: [],
      },
    }),
    { query: "quantum chromodynamics recall" },
  );
  assert.equal(result.status, "no_hits");
});

test("runRecall reports partial when a sibling was unreadable", async () => {
  seq = 0;
  const siblingEvents = [
    ev(events.userMessage({ text: "the recall index uses BM25 ranking", provider: "qwen" }), "sib"),
  ];
  const result = await runRecall(
    deps({
      siblingRead: {
        sessions: [
          {
            session: {
              sessionId: "sib",
              label: "older",
              project: "proj",
              origin: "sibling-session",
            },
            events: siblingEvents,
          },
        ],
        diagnostics: [{ sessionId: "broken", kind: "unreadable", detail: "socket closed" }],
      },
    }),
    { query: "BM25 ranking index" },
  );
  assert.equal(result.status, "partial", "a hit plus an unreadable session is a partial search");
  assert.ok(result.diagnostics.some((d) => d.sessionId === "broken"));
});

test("runRecall rejects an inverted turn range as invalid_filters", async () => {
  const result = await runRecall(deps(), {
    query: "x",
    filters: { turnRange: { fromSeq: 9, toSeq: 2 } },
  });
  assert.equal(result.status, "invalid_filters");
});

test("runRecall surfaces a reasoning-pass failure as error with sources still attached", async () => {
  seq = 0;
  const siblingEvents = [
    ev(
      events.userMessage({
        text: "the compaction fold summary budget is 1k tokens",
        provider: "qwen",
      }),
      "sib",
    ),
  ];
  const result = await runRecall(
    deps({
      provider: () => fakeProvider("", true),
      siblingRead: {
        sessions: [
          {
            session: {
              sessionId: "sib",
              label: "older",
              project: "proj",
              origin: "sibling-session",
            },
            events: siblingEvents,
          },
        ],
        diagnostics: [],
      },
    }),
    { query: "compaction fold summary budget" },
  );
  assert.equal(result.status, "error");
  assert.ok(
    result.sources.length >= 1,
    "sources survive a reasoning failure so the user sees what was found",
  );
  assert.ok(result.diagnostics.some((d) => d.detail.includes("reasoning pass failed")));
});
