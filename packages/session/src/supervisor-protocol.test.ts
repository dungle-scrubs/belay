import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import { SUPERVISOR_SESSION_ID } from "./identity";
import { decodeTrevorEvent, events, type TrevorEventInput } from "./protocol";

/**
 * The supervisor side-channel contract (plan 44.1): three request/result event pairs the browser and
 * the supervisor daemon share, modeled on `file.index.*`. These pin that each `events.*` constructor
 * round-trips through `decodeTrevorEvent` (emit/consume stay in lockstep), that `requestId` correlates
 * a result to its request, and that a malformed request decodes safely to sane defaults rather than
 * throwing or partially dispatching.
 */

/** Wrap an emit-side input into a full stored SessionEvent (what decodeTrevorEvent reads). */
const stored = (input: TrevorEventInput, over: Partial<SessionEvent> = {}): SessionEvent => ({
  sessionId: SUPERVISOR_SESSION_ID,
  seq: 1,
  eventId: "ev-1",
  producerId: "trevor-web",
  createdAt: "2026-07-04T00:00:00.000Z",
  type: input.type,
  payload: input.payload as Record<string, unknown>,
  ...over,
});

test("SUPERVISOR_SESSION_ID is the reserved control session constant", () => {
  assert.equal(SUPERVISOR_SESSION_ID, "trevor-supervisor-control");
});

test("session.launch.requested round-trips its requestId + root", () => {
  const decoded = decodeTrevorEvent(
    stored(events.sessionLaunchRequested({ requestId: "req-1", root: "/work/app" })),
  );
  assert.deepEqual(decoded, {
    type: "session.launch.requested",
    requestId: "req-1",
    root: "/work/app",
  });
});

test("session.launch.result round-trips each status, paired by requestId", () => {
  const launched = decodeTrevorEvent(
    stored(
      events.sessionLaunchResult({
        requestId: "req-2",
        sessionId: "app-abc123",
        status: "launched",
      }),
    ),
  );
  assert.deepEqual(launched, {
    type: "session.launch.result",
    requestId: "req-2",
    sessionId: "app-abc123",
    status: "launched",
  });

  const reused = decodeTrevorEvent(
    stored(
      events.sessionLaunchResult({ requestId: "req-3", sessionId: "app-abc123", status: "reused" }),
    ),
  );
  assert.equal(reused?.type === "session.launch.result" ? reused.status : null, "reused");

  const failed = decodeTrevorEvent(
    stored(
      events.sessionLaunchResult({
        requestId: "req-4",
        sessionId: "",
        status: "failed",
        error: "root does not exist",
      }),
    ),
  );
  assert.deepEqual(failed, {
    type: "session.launch.result",
    requestId: "req-4",
    sessionId: "",
    status: "failed",
    error: "root does not exist",
  });
});

test("folder.pick.requested + result round-trip (path and cancel)", () => {
  assert.deepEqual(decodeTrevorEvent(stored(events.folderPickRequested({ requestId: "fp-1" }))), {
    type: "folder.pick.requested",
    requestId: "fp-1",
  });

  assert.deepEqual(
    decodeTrevorEvent(
      stored(
        events.folderPickResult({ requestId: "fp-2", path: "/Users/me/proj", cancelled: false }),
      ),
    ),
    { type: "folder.pick.result", requestId: "fp-2", cancelled: false, path: "/Users/me/proj" },
  );

  assert.deepEqual(
    decodeTrevorEvent(stored(events.folderPickResult({ requestId: "fp-3", cancelled: true }))),
    { type: "folder.pick.result", requestId: "fp-3", cancelled: true },
  );
});

test("projects.list.requested + result round-trip a recency-sorted list", () => {
  assert.deepEqual(decodeTrevorEvent(stored(events.projectsListRequested({ requestId: "pl-1" }))), {
    type: "projects.list.requested",
    requestId: "pl-1",
  });

  const projects = [
    { root: "/work/b", sessionId: "b-2", updatedAt: "2026-07-04T10:00:00Z" },
    { root: "/work/a", sessionId: "a-1", updatedAt: "2026-07-03T10:00:00Z" },
  ];
  const decoded = decodeTrevorEvent(
    stored(events.projectsListResult({ requestId: "pl-2", projects })),
  );
  assert.deepEqual(decoded, {
    type: "projects.list.result",
    requestId: "pl-2",
    projects,
  });
});

test("a request missing its requestId falls back to the event id (no throw)", () => {
  const decoded = decodeTrevorEvent(
    stored({ type: "session.launch.requested", payload: {} }, { eventId: "ev-fallback" }),
  );
  assert.deepEqual(decoded, {
    type: "session.launch.requested",
    requestId: "ev-fallback",
    root: "",
  });
});

test("a malformed result decodes safely: unknown status -> failed, junk projects dropped", () => {
  const badStatus = decodeTrevorEvent(
    stored({
      type: "session.launch.result",
      payload: { sessionId: 42, status: "exploded" },
    }),
  );
  assert.deepEqual(badStatus, {
    type: "session.launch.result",
    requestId: "ev-1", // missing requestId -> event id fallback
    sessionId: "", // non-string coerced away
    status: "failed", // unknown status -> failed-safe default
  });

  const junkProjects = decodeTrevorEvent(
    stored({
      type: "projects.list.result",
      payload: {
        requestId: "pl-x",
        projects: [
          "not-an-object",
          { root: "/ok", sessionId: "ok-1", updatedAt: "t" },
          { root: "", sessionId: "no-root" }, // missing root -> dropped
          { sessionId: "only-session" }, // missing root -> dropped
        ],
      },
    }),
  );
  assert.deepEqual(junkProjects, {
    type: "projects.list.result",
    requestId: "pl-x",
    projects: [{ root: "/ok", sessionId: "ok-1", updatedAt: "t" }],
  });
});
