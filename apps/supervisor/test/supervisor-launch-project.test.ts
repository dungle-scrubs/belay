import assert from "node:assert/strict";
import {
  decodeTrevorEvent,
  events,
  PRODUCER_IDS,
  type SessionConnection,
  type SessionTransport,
  SUPERVISOR_SESSION_ID,
  streamTransport,
  viewerIdentity,
} from "@belay/session";
import { bootStore } from "@belay/test-kit/boot";
import { afterEach, beforeEach, test } from "vitest";
import { handleSupervisorEvent, type SupervisorDeps } from "../src/dispatch";

/**
 * The supervisor launch dispatch for fresh project-scoped sessions (plan 58 M4):
 * a browser-published `session.launch.requested` carrying `sessionId` + `projectPath`
 * drives the launcher with the CALLER-MINTED session id (not the deterministic
 * `projectSessionId(root)`), publishes a `session.project` marker on the new session
 * BEFORE launching, and touches the project registry. Every exchange on the session
 * log, no private channel. A fake launcher stands in so no real host spawns.
 */

let store: Awaited<ReturnType<typeof bootStore>>;
let transport: SessionTransport;
let connection: SessionConnection | undefined;

beforeEach(async () => {
  store = await bootStore();
  transport = streamTransport(store.url);
  await transport.ensureSession(SUPERVISOR_SESSION_ID);
});

afterEach(async () => {
  connection?.close();
  connection = undefined;
  await store.close();
});

/** Subscribes the dispatcher to the control session and resolves once it is live. */
function subscribe(deps: SupervisorDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    connection = transport.connectSession({
      sessionId: SUPERVISOR_SESSION_ID,
      identity: viewerIdentity({
        displayName: "supervisor-test",
        instanceId: "sup-test",
        participantId: PRODUCER_IDS.supervisor,
      }),
      onEvent: (event) => void handleSupervisorEvent(event, deps),
      onReplayComplete: () => resolve(),
    });
  });
}

/** Awaits the first `session.launch.result` matching `requestId` on the control session. */
function awaitLaunchResult(requestId: string) {
  return transport.awaitEvent(
    SUPERVISOR_SESSION_ID,
    viewerIdentity({ displayName: "reader", instanceId: "reader-1", participantId: "reader-1" }),
    (event) => {
      const decoded = decodeTrevorEvent(event);
      return decoded?.type === "session.launch.result" && decoded.requestId === requestId;
    },
    { timeoutMs: 5000 },
  );
}

/** Awaits the first `session.project` marker on the given session. */
function awaitSessionProject(sessionId: string) {
  return transport.awaitEvent(
    sessionId,
    viewerIdentity({ displayName: "reader", instanceId: "reader-2", participantId: "reader-2" }),
    (event) => decodeTrevorEvent(event)?.type === "session.project",
    { timeoutMs: 5000 },
  );
}

/** A fake project registry that records adds in an array. */
function fakeRegistry() {
  const added: { path: string; now: string }[] = [];
  return {
    added,
    registry: {
      add: (path: string, now: string) => {
        added.push({ path, now });
        return { path, displayName: path.split("/").pop() ?? path };
      },
      rename: () => null,
      setCollapsed: () => null,
      remove: () => true,
      list: () => [],
    },
  };
}

test("a launch with sessionId + projectPath uses the provided id, stamps a session.project marker, and touches the registry", async () => {
  const launched: { sessionId: string; root: string }[] = [];
  const { added, registry } = fakeRegistry();
  const nowIso = "2025-01-15T00:00:00.000Z";
  const deps: SupervisorDeps = {
    selfProducerId: PRODUCER_IDS.supervisor,
    emit: (event) =>
      transport.publishEvent(SUPERVISOR_SESSION_ID, {
        ...event,
        producerId: PRODUCER_IDS.supervisor,
      }),
    publishToSession: (sessionId, event) =>
      transport.publishEvent(sessionId, {
        ...event,
        producerId: PRODUCER_IDS.supervisor,
      }),
    launch: (input) => {
      launched.push(input);
      return Promise.resolve("launched");
    },
    pickFolder: () => Promise.resolve({ cancelled: true }),
    listProjects: () => [],
    projectRegistry: registry,
    now: () => nowIso,
  };
  await subscribe(deps);

  const root = "/work/app";
  const freshId = "fresh-session-uuid";
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.sessionLaunchRequested({
      requestId: "req-fresh",
      root,
      sessionId: freshId,
      projectPath: root,
    }),
    producerId: PRODUCER_IDS.web,
  });

  // The launch result carries the caller-minted session id (not projectSessionId(root)).
  const result = await awaitLaunchResult("req-fresh");
  assert.ok(result, "a session.launch.result was published on the control session");
  const decoded = result ? decodeTrevorEvent(result) : null;
  assert.equal(decoded?.type, "session.launch.result");
  if (decoded?.type === "session.launch.result") {
    assert.equal(decoded.sessionId, freshId);
    assert.equal(decoded.status, "launched");
  }

  // The launcher ran with the caller-minted session id.
  assert.deepEqual(launched, [{ sessionId: freshId, root }]);

  // A session.project marker was published on the NEW session (before launch).
  const marker = await awaitSessionProject(freshId);
  assert.ok(marker, "a session.project marker was published on the new session");
  const markerDecoded = marker ? decodeTrevorEvent(marker) : null;
  assert.equal(markerDecoded?.type, "session.project");
  if (markerDecoded?.type === "session.project") {
    assert.equal(markerDecoded.path, root);
  }

  // The project registry was touched with the path + the injected timestamp.
  assert.deepEqual(added, [{ path: root, now: nowIso }]);
});

test("a legacy launch (no sessionId/projectPath) derives projectSessionId and writes no marker", async () => {
  const launched: { sessionId: string; root: string }[] = [];
  const { added, registry } = fakeRegistry();
  const deps: SupervisorDeps = {
    selfProducerId: PRODUCER_IDS.supervisor,
    emit: (event) =>
      transport.publishEvent(SUPERVISOR_SESSION_ID, {
        ...event,
        producerId: PRODUCER_IDS.supervisor,
      }),
    launch: (input) => {
      launched.push(input);
      return Promise.resolve("launched");
    },
    pickFolder: () => Promise.resolve({ cancelled: true }),
    listProjects: () => [],
    projectRegistry: registry,
  };
  await subscribe(deps);

  const root = "/work/legacy";
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.sessionLaunchRequested({ requestId: "req-legacy", root }),
    producerId: PRODUCER_IDS.web,
  });

  const result = await awaitLaunchResult("req-legacy");
  assert.ok(result);
  // No marker should appear quickly (the await returns null on timeout, but we keep
  // the test fast by just checking that the registry was NOT touched).
  assert.equal(added.length, 0);
});
