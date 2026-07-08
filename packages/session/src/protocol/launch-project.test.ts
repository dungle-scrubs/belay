import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "../event";
import { decodeTrevorEvent, events } from "../protocol";

/**
 * Round-trip tests for the plan 58 M4 `session.launch.requested` extension: the
 * constructor and decoder must carry the optional `sessionId` + `projectPath`
 * fields through the wire when present, and omit them cleanly when absent (the
 * legacy shape stays byte-identical for existing callers).
 */

/** Wraps a `TrevorEventInput` in a minimal `SessionEvent` for decode. */
function wrap(input: ReturnType<typeof events.raw>): SessionEvent {
  return {
    eventId: "ev-0",
    sessionId: "s-0",
    seq: 0,
    producerId: "web",
    type: input.type,
    payload: input.payload,
    createdAt: "0",
  };
}

test("sessionLaunchRequested round-trips the legacy shape (no optionals)", () => {
  const req = events.sessionLaunchRequested({ requestId: "r-1", root: "/work/app" });
  const decoded = decodeTrevorEvent(wrap(req));
  assert.deepEqual(decoded, {
    type: "session.launch.requested",
    requestId: "r-1",
    root: "/work/app",
  });
});

test("sessionLaunchRequested round-trips with sessionId + projectPath", () => {
  const req = events.sessionLaunchRequested({
    requestId: "r-2",
    root: "/work/app",
    sessionId: "fresh-uuid",
    projectPath: "/work/app",
  });
  const decoded = decodeTrevorEvent(wrap(req));
  assert.deepEqual(decoded, {
    type: "session.launch.requested",
    requestId: "r-2",
    root: "/work/app",
    sessionId: "fresh-uuid",
    projectPath: "/work/app",
  });
});

test("sessionLaunchRequested omits empty optionals (permissive decode)", () => {
  const req = events.sessionLaunchRequested({
    requestId: "r-3",
    root: "/work/app",
    sessionId: "",
    projectPath: "",
  });
  const decoded = decodeTrevorEvent(wrap(req));
  assert.deepEqual(decoded, {
    type: "session.launch.requested",
    requestId: "r-3",
    root: "/work/app",
  });
});
