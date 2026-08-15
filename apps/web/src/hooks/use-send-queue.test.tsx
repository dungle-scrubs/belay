import assert from "node:assert/strict";
import { PRODUCER_IDS, type SessionEvent, type SupersedeReason } from "@belay/session";
import { storedEvent } from "@belay/test-kit";
import { act, renderHook } from "@testing-library/react";
import { test } from "vitest";
import type { UserTurnInput } from "@/send-queue";
import { useSendQueue } from "./use-send-queue";

/**
 * The durable follow-up queue binding (plan 47). The browser stopped being the scheduler: submit
 * publishes immediately, the queue is projected from the log, and the Escape-fold / unqueue / recall
 * pull emit durable supersedes. These drive the hook in a DOM against a recording publish + supersede.
 */

const HOST = PRODUCER_IDS.host;
let seq = 0;
const userEv = (eventId: string, text: string): SessionEvent =>
  storedEvent(
    { type: "user.message", payload: { text, provider: "qwen" } },
    { seq: seq++, eventId, producerId: PRODUCER_IDS.web },
  );
const startedEv = (runId: string): SessionEvent =>
  storedEvent({ type: "assistant.started", payload: { runId } }, { seq: seq++, producerId: HOST });

function harness(events: readonly SessionEvent[]) {
  const published: string[] = [];
  const superseded: Array<{ ids: readonly string[]; reason: SupersedeReason }> = [];
  const publish = async (p: UserTurnInput) => {
    published.push(p.text);
  };
  const supersede = async (ids: readonly string[], reason: SupersedeReason) => {
    superseded.push({ ids, reason });
  };
  const view = renderHook(
    (props: { events: readonly SessionEvent[] }) =>
      useSendQueue({ events: props.events, selfProducerId: HOST, publish, supersede }),
    { initialProps: { events } },
  );
  return { view, published, superseded };
}

test("the queue is projected from the log (follow-ups behind the active turn), in order", () => {
  const log = [userEv("e1", "active"), startedEv("r1"), userEv("e2", "two"), userEv("e3", "three")];
  const { view } = harness(log);
  assert.deepEqual(
    view.result.current.queue.map((q) => ({ id: q.id, text: q.text })),
    [
      { id: "e2", text: "two" },
      { id: "e3", text: "three" },
    ],
  );
});

test("submit publishes immediately (no busy-gate); the host owns scheduling", async () => {
  const { view, published } = harness([userEv("e1", "active"), startedEv("r1")]);
  await act(async () => {
    view.result.current.submit({ text: "follow up", provider: "qwen" });
  });
  assert.deepEqual(published, ["follow up"]);
});

test("flushQueuedSteer folds the queue into one prompt + supersedes the folded ids (fold)", async () => {
  const log = [userEv("e1", "active"), startedEv("r1"), userEv("e2", "two"), userEv("e3", "three")];
  const { view, published, superseded } = harness(log);
  await act(async () => {
    view.result.current.flushQueuedSteer({ id: "s", provider: "qwen" });
  });
  assert.deepEqual(
    published,
    ["two\nthree"],
    "one folded steering prompt, one line per queued prompt",
  );
  assert.deepEqual(superseded, [{ ids: ["e2", "e3"], reason: "fold" }]);
});

test("flushQueuedSteer is a no-op with an empty queue (nothing to fold)", async () => {
  const { view, published, superseded } = harness([userEv("e1", "active"), startedEv("r1")]);
  await act(async () => {
    view.result.current.flushQueuedSteer({ id: "s", provider: "qwen" });
  });
  assert.deepEqual(published, []);
  assert.deepEqual(superseded, []);
});

test("unqueue supersedes one prompt with no replacement", async () => {
  const log = [userEv("e1", "active"), startedEv("r1"), userEv("e2", "drop me")];
  const { view, published, superseded } = harness(log);
  await act(async () => {
    view.result.current.unqueue("e2");
  });
  assert.deepEqual(published, [], "unqueue publishes no replacement");
  assert.deepEqual(superseded, [{ ids: ["e2"], reason: "unqueue" }]);
});

test("pullNewest supersedes the newest queued prompt (recall) and returns it for the composer", async () => {
  const log = [
    userEv("e1", "active"),
    startedEv("r1"),
    userEv("e2", "older"),
    userEv("e3", "newest"),
  ];
  const { view, superseded } = harness(log);
  let pulled: { id: string; text: string } | null = null;
  await act(async () => {
    const result = view.result.current.pullNewest();
    pulled = result ? { id: result.id, text: result.text } : null;
  });
  assert.deepEqual(pulled, { id: "e3", text: "newest" });
  assert.deepEqual(superseded, [{ ids: ["e3"], reason: "recall" }]);
});

test("pullNewest returns null with an empty queue", async () => {
  const { view, superseded } = harness([userEv("e1", "active"), startedEv("r1")]);
  let hadResult = true;
  await act(async () => {
    hadResult = view.result.current.pullNewest() !== null;
  });
  assert.equal(hadResult, false, "nothing to pull from an empty queue");
  assert.deepEqual(superseded, []);
});
