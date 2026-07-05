import assert from "node:assert/strict";
import {
  decodeTrevorEvent,
  events,
  PRODUCER_IDS,
  projectSessionId,
  type SessionConnection,
  SUPERVISOR_SESSION_ID,
  streamTransport,
  viewerIdentity,
} from "@trevor/session";
import { bootStore } from "@trevor/test-kit/boot";
import { afterEach, beforeEach, test } from "vitest";
import { handleSupervisorEvent, type SupervisorDeps } from "../src/dispatch";

/**
 * The supervisor launch dispatch over a REAL session-store (plan 44.1 M3): with the dispatcher
 * subscribed to the control session, a browser-published `session.launch.requested { root }` drives the
 * (fake) launcher and publishes a `session.launch.result` carrying the resolved session id + status -
 * every exchange on the session log, no private channel. A fake launcher stands in so no real host
 * spawns. It also pins the self-echo gate (a supervisor-produced request is ignored) and the failure
 * path (a launcher rejection becomes a `failed` result, not a crash).
 */

let store: Awaited<ReturnType<typeof bootStore>>;
let transport: ReturnType<typeof streamTransport>;
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

/** Subscribes the dispatcher to the control session and resolves once it is live (replay complete). */
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
function awaitResult(requestId: string) {
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

test("a control-session launch request drives the launcher and returns the resolved session id", async () => {
  const launched: { sessionId: string; root: string }[] = [];
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
  };
  await subscribe(deps);

  const root = "/work/app";
  // A self-produced request first (must be ignored by the self-echo gate)...
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.sessionLaunchRequested({ requestId: "self-req", root: "/self/only" }),
    producerId: PRODUCER_IDS.supervisor,
  });
  // ...then the browser request the supervisor should answer.
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.sessionLaunchRequested({ requestId: "req-1", root }),
    producerId: PRODUCER_IDS.web,
  });

  const result = await awaitResult("req-1");
  assert.ok(result, "a session.launch.result was published on the control session");
  const decoded = result ? decodeTrevorEvent(result) : null;
  assert.equal(decoded?.type, "session.launch.result");
  if (decoded?.type === "session.launch.result") {
    assert.equal(decoded.sessionId, projectSessionId(root));
    assert.equal(decoded.status, "launched");
  }
  // The fake launcher ran exactly once (the self-produced request was suppressed), for the browser root.
  assert.deepEqual(launched, [{ sessionId: projectSessionId(root), root }]);
});

test("a launcher failure becomes a failed result carrying the error, not a crash", async () => {
  const deps: SupervisorDeps = {
    selfProducerId: PRODUCER_IDS.supervisor,
    emit: (event) =>
      transport.publishEvent(SUPERVISOR_SESSION_ID, {
        ...event,
        producerId: PRODUCER_IDS.supervisor,
      }),
    launch: () => Promise.reject(new Error("spawn denied")),
    pickFolder: () => Promise.resolve({ cancelled: true }),
    listProjects: () => [],
  };
  await subscribe(deps);

  const root = "/work/broken";
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.sessionLaunchRequested({ requestId: "req-fail", root }),
    producerId: PRODUCER_IDS.web,
  });

  const result = await awaitResult("req-fail");
  const decoded = result ? decodeTrevorEvent(result) : null;
  assert.equal(decoded?.type, "session.launch.result");
  if (decoded?.type === "session.launch.result") {
    assert.equal(decoded.sessionId, projectSessionId(root));
    assert.equal(decoded.status, "failed");
    assert.match(decoded.error ?? "", /spawn denied/);
  }
});
