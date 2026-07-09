import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import { pendingFollowUps, queuedFollowUps, supersededMessageIds } from "./follow-up-queue";
import { PRODUCER_IDS, type ProducerId } from "./identity";
import { events, type TrevorEventInput } from "./protocol";

/**
 * The durable follow-up queue derivation (plan 47 M2/M3): the single ordering rule the host's leader
 * catch-up and the web's queued-prompt panel both read. Pending = every answerable user.message no turn
 * has claimed yet and that is not superseded, in seq order.
 *
 * Events are built inline (no @trevor/test-kit - that would cycle into this core package).
 */

let seq = 0;
const ev = (input: TrevorEventInput, producerId: ProducerId = PRODUCER_IDS.web): SessionEvent => {
  const n = seq++;
  return {
    sessionId: "s",
    seq: n,
    eventId: `ev-${n}`,
    producerId,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
};

const HOST = PRODUCER_IDS.host;
const texts = (list: readonly SessionEvent[]): string[] =>
  list.map((e) => (typeof e.payload.text === "string" ? e.payload.text : ""));

test("returns every unanswered follow-up in seq order (not just the latest)", () => {
  const u1 = ev(events.userMessage({ text: "one", provider: "qwen" }));
  const started = ev(
    events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }),
    HOST,
  );
  const u2 = ev(events.userMessage({ text: "two", provider: "qwen" }));
  const u3 = ev(events.userMessage({ text: "three", provider: "qwen" }));
  // u1 is claimed by run r1 (started); u2 + u3 are queued behind it, in order.
  assert.deepEqual(texts(pendingFollowUps([u1, started, u2, u3], HOST)), ["two", "three"]);
});

test("a run claims exactly one prompt (started + completed share a runId)", () => {
  const log = [
    ev(events.userMessage({ text: "a", provider: "qwen" })),
    ev(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }), HOST),
    ev(events.assistantCompleted({ runId: "r1", text: "did a" }), HOST),
    ev(events.userMessage({ text: "b", provider: "qwen" })),
    ev(events.userMessage({ text: "c", provider: "qwen" })),
  ];
  // r1 claims only "a" (its started + completed count once); b + c stay queued.
  assert.deepEqual(texts(pendingFollowUps(log, HOST)), ["b", "c"]);
});

test("an attempted-then-orphaned prompt is claimed and never returned (no restart loop)", () => {
  const log = [
    ev(events.userMessage({ text: "read the whole codebase", provider: "qwen" })),
    ev(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }), HOST),
    // host crashed: no completion. The prompt is still claimed by r1, so catch-up must NOT re-run it.
  ];
  assert.deepEqual(pendingFollowUps(log, HOST), []);
});

test("a never-attempted prompt (arrived during a leadership gap) is pending", () => {
  const log = [ev(events.userMessage({ text: "hello", provider: "qwen" }))];
  assert.deepEqual(texts(pendingFollowUps(log, HOST)), ["hello"]);
});

test("supersede retracts a queued prompt from the pending set but stays on the log", () => {
  const u1 = ev(events.userMessage({ text: "one", provider: "qwen" }));
  const started = ev(
    events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }),
    HOST,
  );
  const u2 = ev(events.userMessage({ text: "two", provider: "qwen" }));
  const u3 = ev(events.userMessage({ text: "three", provider: "qwen" }));
  const sup = ev(events.userSupersede({ supersedes: [u2.eventId], reason: "unqueue" }));
  const log = [u1, started, u2, u3, sup];
  // u2 is superseded (unqueued) - excluded from pending, but the supersede event is still on the log.
  assert.deepEqual(texts(pendingFollowUps(log, HOST)), ["three"]);
  assert.deepEqual([...supersededMessageIds(log)], [u2.eventId]);
});

test("Escape-fold: N superseded + one folded replacement leaves only the replacement queued", () => {
  const u1 = ev(events.userMessage({ text: "active", provider: "qwen" }));
  const started = ev(
    events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }),
    HOST,
  );
  const u2 = ev(events.userMessage({ text: "two", provider: "qwen" }));
  const u3 = ev(events.userMessage({ text: "three", provider: "qwen" }));
  // The fold publishes ONE folded steering user.message + a supersede naming the two folded prompts.
  const folded = ev(events.userMessage({ text: "two\nthree", provider: "qwen" }));
  const sup = ev(events.userSupersede({ supersedes: [u2.eventId, u3.eventId], reason: "fold" }));
  const log = [u1, started, u2, u3, folded, sup];
  assert.deepEqual(texts(pendingFollowUps(log, HOST)), ["two\nthree"]);
});

test("a /clear resets the queue", () => {
  const log = [
    ev(events.userMessage({ text: "before", provider: "qwen" })),
    ev(events.userCommand({ command: "/clear", args: "" })),
    ev(events.userMessage({ text: "after", provider: "qwen" })),
  ];
  assert.deepEqual(texts(pendingFollowUps(log, HOST)), ["after"]);
});

test("the host's own user.message echo is not a queued prompt", () => {
  const log = [
    ev(events.userMessage({ text: "browser prompt", provider: "qwen" }), PRODUCER_IDS.web),
    ev(events.userMessage({ text: "host echo", provider: "qwen" }), HOST),
  ];
  assert.deepEqual(texts(pendingFollowUps(log, HOST)), ["browser prompt"]);
});

test("a survived-restart backlog re-derives from the log alone, in order", () => {
  // No host acted on any of these (a standby that never led): all three are pending, in submit order.
  const log = [
    ev(events.userMessage({ text: "1", provider: "qwen" })),
    ev(events.userMessage({ text: "2", provider: "qwen" })),
    ev(events.userMessage({ text: "3", provider: "qwen" })),
  ];
  assert.deepEqual(texts(pendingFollowUps(log, HOST)), ["1", "2", "3"]);
});

test("queuedFollowUps hides the current awaiting prompt when no turn has started", () => {
  const log = [
    ev(events.userMessage({ text: "awaiting", provider: "qwen" })),
    ev(events.userMessage({ text: "queued", provider: "qwen" })),
  ];
  assert.deepEqual(
    texts(queuedFollowUps(log, HOST)),
    ["queued"],
    "only prompts behind the current awaiting row belong in the visible queue",
  );
});

test("queuedFollowUps returns every pending prompt while a turn is in flight", () => {
  const log = [
    ev(events.userMessage({ text: "active", provider: "qwen" })),
    ev(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }), HOST),
    ev(events.userMessage({ text: "two", provider: "qwen" })),
    ev(events.userMessage({ text: "three", provider: "qwen" })),
  ];
  assert.deepEqual(texts(queuedFollowUps(log, HOST)), ["two", "three"]);
});
