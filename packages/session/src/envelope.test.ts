import assert from "node:assert/strict";
import { Either } from "effect";
import { test } from "vitest";
import { decodeStreamEnvelope, frames, type StreamEnvelope } from "./envelope";
import type { SessionEvent } from "./event";

/**
 * The stream envelope is the replay-then-tail wire framing. `frames.*` is the single
 * source of the `op` vocabulary; `decodeStreamEnvelope` returns Either so the client can
 * ignore frames it does not understand. These guard round-trip fidelity and the
 * forward-compatibility contract: an unknown op decodes Left and is dropped, not fatal.
 */

const event: SessionEvent = {
  sessionId: "s",
  seq: 1,
  eventId: "ev-1",
  producerId: "host",
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "user.message",
  payload: { text: "hi" },
};

const decoded = (frame: StreamEnvelope) => decodeStreamEnvelope(frame as unknown);

test("frames.event round-trips through decodeStreamEnvelope", () => {
  const result = decoded(frames.event(event));
  assert.equal(Either.isRight(result), true);
  if (Either.isRight(result) && result.right.op === "event") {
    assert.equal(result.right.event.eventId, "ev-1");
  }
});

test("frames.presence and replayComplete round-trip", () => {
  const presence = decoded(
    frames.presence([{ instanceId: "h1", participantId: "p1", displayName: "Host" }]),
  );
  assert.equal(Either.isRight(presence), true);
  assert.equal(Either.isRight(decoded(frames.replayComplete())), true);
});

test("frames.commandResult omits requestId when absent", () => {
  assert.equal("requestId" in frames.commandResult("/clear"), false);
  assert.equal("requestId" in frames.commandResult("/clear", "req-1"), true);
});

test("an unknown op fails decode (Left), so clients ignore it", () => {
  assert.equal(Either.isLeft(decodeStreamEnvelope({ op: "future.frame", x: 1 })), true);
  assert.equal(Either.isLeft(decodeStreamEnvelope("not even an object")), true);
});
