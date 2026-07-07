import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "../event";
import { decodeTrevorEvent, events } from "../protocol";

/**
 * Round-trip tests for the plan 58 M2 project operation events: each constructor
 * builds a `TrevorEventInput`, it is wrapped in a `SessionEvent`, decoded back, and
 * the decoded shape must survive the wire intact. Optional fields are omitted (not
 * emitted as null/undefined) so the wire stays minimal, and the decoder coerces
 * permissively (missing optionals stay absent).
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

test("projectAddRequested / projectAddResult round-trip with a picked path", () => {
  const req = events.projectAddRequested({ requestId: "pa-1" });
  const decodedReq = decodeTrevorEvent(wrap(req));
  assert.deepEqual(decodedReq, { type: "project.add.requested", requestId: "pa-1" });

  const res = events.projectAddResult({
    requestId: "pa-1",
    path: "/Users/me/proj",
    displayName: "proj",
    cancelled: false,
  });
  const decodedRes = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decodedRes, {
    type: "project.add.result",
    requestId: "pa-1",
    path: "/Users/me/proj",
    displayName: "proj",
    cancelled: false,
  });
});

test("projectAddResult round-trip when cancelled (path/displayName omitted)", () => {
  const res = events.projectAddResult({ requestId: "pa-2", cancelled: true });
  const decoded = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decoded, {
    type: "project.add.result",
    requestId: "pa-2",
    cancelled: true,
  });
});

test("projectAddResult round-trip with an error", () => {
  const res = events.projectAddResult({
    requestId: "pa-3",
    cancelled: false,
    error: "disk full",
  });
  const decoded = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decoded, {
    type: "project.add.result",
    requestId: "pa-3",
    cancelled: false,
    error: "disk full",
  });
});

test("projectRenameRequested / projectRenameResult round-trip", () => {
  const req = events.projectRenameRequested({
    requestId: "pr-1",
    path: "/Users/me/proj",
    displayName: "My Project",
  });
  const decodedReq = decodeTrevorEvent(wrap(req));
  assert.deepEqual(decodedReq, {
    type: "project.rename.requested",
    requestId: "pr-1",
    path: "/Users/me/proj",
    displayName: "My Project",
  });

  const res = events.projectRenameResult({
    requestId: "pr-1",
    path: "/Users/me/proj",
    displayName: "My Project",
  });
  const decodedRes = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decodedRes, {
    type: "project.rename.result",
    requestId: "pr-1",
    path: "/Users/me/proj",
    displayName: "My Project",
  });
});

test("projectRenameResult round-trip with an error (unknown path)", () => {
  const res = events.projectRenameResult({
    requestId: "pr-2",
    path: "/nope",
    error: "project not found",
  });
  const decoded = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decoded, {
    type: "project.rename.result",
    requestId: "pr-2",
    path: "/nope",
    error: "project not found",
  });
});

test("projectCollapseRequested / projectCollapseResult round-trip", () => {
  const req = events.projectCollapseRequested({
    requestId: "pc-1",
    path: "/Users/me/proj",
    collapsed: true,
  });
  const decodedReq = decodeTrevorEvent(wrap(req));
  assert.deepEqual(decodedReq, {
    type: "project.collapse.requested",
    requestId: "pc-1",
    path: "/Users/me/proj",
    collapsed: true,
  });

  const res = events.projectCollapseResult({
    requestId: "pc-1",
    path: "/Users/me/proj",
    collapsed: true,
  });
  const decodedRes = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decodedRes, {
    type: "project.collapse.result",
    requestId: "pc-1",
    path: "/Users/me/proj",
    collapsed: true,
  });
});

test("projectCollapseResult round-trip with an error", () => {
  const res = events.projectCollapseResult({
    requestId: "pc-2",
    path: "/nope",
    collapsed: false,
    error: "project not found",
  });
  const decoded = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decoded, {
    type: "project.collapse.result",
    requestId: "pc-2",
    path: "/nope",
    collapsed: false,
    error: "project not found",
  });
});

test("projectRemoveRequested / projectRemoveResult round-trip", () => {
  const req = events.projectRemoveRequested({ requestId: "prm-1", path: "/Users/me/proj" });
  const decodedReq = decodeTrevorEvent(wrap(req));
  assert.deepEqual(decodedReq, {
    type: "project.remove.requested",
    requestId: "prm-1",
    path: "/Users/me/proj",
  });

  const res = events.projectRemoveResult({
    requestId: "prm-1",
    path: "/Users/me/proj",
    removed: true,
  });
  const decodedRes = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decodedRes, {
    type: "project.remove.result",
    requestId: "prm-1",
    path: "/Users/me/proj",
    removed: true,
  });
});

test("projectRemoveResult round-trip with an error", () => {
  const res = events.projectRemoveResult({
    requestId: "prm-2",
    path: "/nope",
    removed: false,
    error: "project not found",
  });
  const decoded = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decoded, {
    type: "project.remove.result",
    requestId: "prm-2",
    path: "/nope",
    removed: false,
    error: "project not found",
  });
});

test("projectRemoveResult round-trip with blockedBy", () => {
  const res = events.projectRemoveResult({
    requestId: "prm-3",
    path: "/Users/me/proj",
    removed: false,
    blockedBy: ["session-a", "session-b"],
  });
  const decoded = decodeTrevorEvent(wrap(res));
  assert.deepEqual(decoded, {
    type: "project.remove.result",
    requestId: "prm-3",
    path: "/Users/me/proj",
    removed: false,
    blockedBy: ["session-a", "session-b"],
  });
});
