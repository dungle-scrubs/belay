import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import { decodeTrevorEvent, events, type TrevorEventInput } from "./protocol";

/**
 * The protocol is the single source of truth shared by host and web: `events.*` builds
 * the wire payload, `decodeTrevorEvent` reads it back permissively. These guard the two
 * properties the rest of the system leans on - the emit/consume sides stay in lockstep,
 * and decode never throws (unknown -> null, missing correlation id -> the event's own id).
 */

/** Wrap an emit-side input into a full stored SessionEvent (what decodeTrevorEvent reads). */
const stored = (input: TrevorEventInput, over: Partial<SessionEvent> = {}): SessionEvent => ({
  sessionId: "s",
  seq: 1,
  eventId: "ev-1",
  producerId: "host",
  createdAt: "2026-01-01T00:00:00.000Z",
  type: input.type,
  payload: input.payload as Record<string, unknown>,
  ...over,
});

test("events.userMessage round-trips through decodeTrevorEvent", () => {
  const decoded = decodeTrevorEvent(stored(events.userMessage({ text: "hi", provider: "qwen" })));
  assert.equal(decoded?.type, "user.message");
  assert.deepEqual(decoded, {
    type: "user.message",
    text: "hi",
    provider: "qwen",
    reasoning: undefined,
    artifacts: [],
  });
});

test("optional fields are omitted on the wire, not sent as null", () => {
  const completed = events.assistantCompleted({ runId: "r", text: "x" });
  assert.equal("usage" in completed.payload, false);
  assert.equal("error" in completed.payload, false);
  assert.equal("cancelled" in completed.payload, false);

  const msg = events.userMessage({ text: "hi", provider: "qwen" });
  assert.equal("reasoning" in msg.payload, false);
  assert.equal("artifacts" in msg.payload, false);
});

test("an unknown event type decodes to null (forward-compatible)", () => {
  assert.equal(decodeTrevorEvent(stored({ type: "future.thing", payload: {} })), null);
});

test("a missing runId falls back to the event's own id, never collapsing turns", () => {
  const decoded = decodeTrevorEvent(
    stored({ type: "assistant.delta", payload: { text: "hi" } }, { eventId: "ev-9" }),
  );
  assert.equal(decoded?.type, "assistant.delta");
  assert.equal(decoded?.type === "assistant.delta" && decoded.runId, "ev-9");
});

test("assistant.completed coerces cancelled/noReply/stepLimit to safe defaults", () => {
  const decoded = decodeTrevorEvent(stored(events.assistantCompleted({ runId: "r", text: "ok" })));
  assert.equal(decoded?.type, "assistant.completed");
  if (decoded?.type !== "assistant.completed") return;
  assert.equal(decoded.cancelled, false);
  assert.equal(decoded.noReply, false);
  assert.equal(decoded.stepLimit, 0);
  assert.equal(decoded.usage, undefined);
});
