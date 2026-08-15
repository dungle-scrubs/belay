import assert from "node:assert/strict";
import {
  activeTurnRunId,
  events,
  PRODUCER_IDS,
  type SessionEvent,
  type TrevorEventInput,
} from "@belay/session";
import { storedEvent } from "@belay/test-kit";
import { test } from "vitest";
import { queuedPromptsFrom } from "./send-queue";
import { type Message, TranscriptProjector, toTranscript } from "./transcript";

const HOST = PRODUCER_IDS.host;
const WEB = "web-1";

// A stored event at `seq`, from the host by default (assistant/tool lifecycle) or the web (user prompts).
const host = (seq: number, input: TrevorEventInput): SessionEvent =>
  storedEvent(input, { seq, producerId: HOST, createdAt: "2026-06-24T00:00:00.000Z" });
const web = (seq: number, input: TrevorEventInput): SessionEvent =>
  storedEvent(input, { seq, producerId: WEB, createdAt: "2026-06-24T00:00:00.000Z" });

// A rich log exercising the streaming, tool, inline-agent, compaction, and follow-up-queue paths - the
// event families whose in-place mutation the projector must reproduce and re-clone correctly.
function richLog(): SessionEvent[] {
  const u1 = web(1, events.userMessage({ text: "first", provider: "qwen" }));
  const u2 = web(9, events.userMessage({ text: "queued follow-up", provider: "qwen" }));
  return [
    u1,
    host(2, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    host(3, events.assistantThinking({ runId: "r1", text: "hmm " })),
    host(4, events.assistantDelta({ runId: "r1", text: "answer part 1 " })),
    host(
      5,
      events.toolStarted({ runId: "r1", callId: "c1", name: "read", arguments: '{"p":"a"}' }),
    ),
    host(6, events.toolCompleted({ runId: "r1", callId: "c1", name: "read", result: "file a" })),
    host(7, events.assistantDelta({ runId: "r1", text: "answer part 2" })),
    host(8, events.assistantCompleted({ runId: "r1", text: "answer part 1 answer part 2" })),
    // u2 arrives, then a new turn claims it and streams - so u2 is briefly queued, then the awaiting row.
    u2,
    host(10, events.assistantStarted({ runId: "r2", model: "qwen", provider: "qwen", warm: true })),
    host(11, events.assistantDelta({ runId: "r2", text: "streaming " })),
    host(12, events.assistantDelta({ runId: "r2", text: "reply" })),
  ];
}

test("Tier 0.1: incremental projection matches the eager fold at every prefix", () => {
  const log = richLog();
  const projector = new TranscriptProjector({ selfProducerId: HOST });
  for (let i = 1; i <= log.length; i += 1) {
    const prefix = log.slice(0, i);
    projector.applyAll(prefix);
    const projection = projector.project();
    assert.deepEqual(
      projection.transcript,
      toTranscript(prefix, { selfProducerId: HOST }),
      `transcript diverged at prefix length ${i}`,
    );
    assert.equal(projection.activeRunId, activeTurnRunId(prefix), `activeRunId at ${i}`);
    assert.deepEqual(projection.queued, queuedPromptsFrom(prefix, HOST), `queued at ${i}`);
    assert.equal(
      projection.awaitingResponse,
      toTranscript(prefix, { selfProducerId: HOST }).at(-1)?.kind === "user",
      `awaitingResponse at ${i}`,
    );
  }
});

test("Tier 0.1: a single-batch replay equals the same log fed one event at a time", () => {
  const log = richLog();

  const batched = new TranscriptProjector({ selfProducerId: HOST });
  batched.applyAll(log);

  const incremental = new TranscriptProjector({ selfProducerId: HOST });
  for (let i = 1; i <= log.length; i += 1) {
    incremental.applyAll(log.slice(0, i));
  }

  assert.deepEqual(batched.project().transcript, incremental.project().transcript);
});

test("Tier 0.1: structural sharing - a streaming delta re-clones only the streaming row", () => {
  const log = richLog();
  const projector = new TranscriptProjector({ selfProducerId: HOST });

  // Fold through the first streaming delta of r2 (seq 11), snapshot the rows.
  projector.applyAll(log.slice(0, 11));
  const before = projector.project().transcript;
  const streamingBefore = before.at(-1);
  assert.equal(streamingBefore?.kind, "assistant");

  // One more delta (seq 12) mutates only the r2 segment.
  projector.applyAll(log.slice(0, 12));
  const after = projector.project().transcript;

  // Every row except the streaming segment keeps its exact object identity...
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length - 1; i += 1) {
    assert.equal(after[i], before[i], `row ${i} should keep identity across a streaming delta`);
  }
  // ...and the streaming row is a fresh object carrying the appended text.
  const streamingAfter = after.at(-1);
  assert.notEqual(streamingAfter, streamingBefore, "streaming row must get a new identity");
  assert.equal(
    streamingAfter?.kind === "assistant" ? streamingAfter.text : null,
    "streaming reply",
  );
});

test("Tier 0.1: a retroactive supersede hides an already-emitted prompt without churning others", () => {
  const u1 = web(1, events.userMessage({ text: "keep", provider: "qwen" }));
  const start = host(
    2,
    events.assistantStarted({ runId: "r1", model: "m", provider: "qwen", warm: true }),
  );
  const u2 = web(3, events.userMessage({ text: "retract me", provider: "qwen" }));
  const projector = new TranscriptProjector({ selfProducerId: HOST });

  projector.applyAll([u1, start, u2]);
  const before = projector.project().transcript;
  // u2 is queued behind r1, so it is already filtered out of the main flow (only u1 shows).
  assert.deepEqual(
    before.filter((m) => m.kind === "user").map((m) => (m.kind === "user" ? m.text : "")),
    ["keep"],
  );

  const supersede = web(4, events.userSupersede({ supersedes: [u2.eventId], reason: "unqueue" }));
  projector.applyAll([u1, start, u2, supersede]);
  const after = projector.project();

  // u2 is now retracted from the queue, and the visible rows still match the eager fold exactly.
  assert.deepEqual(after.queued, []);
  assert.deepEqual(
    after.transcript,
    toTranscript([u1, start, u2, supersede], { selfProducerId: HOST }),
  );
  // u1's row kept its identity across the supersede.
  const userBefore = before.find((m: Message) => m.kind === "user");
  const userAfter = after.transcript.find((m) => m.kind === "user");
  assert.equal(userAfter, userBefore, "unaffected prompt row should keep identity");
});
