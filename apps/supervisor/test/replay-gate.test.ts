import assert from "node:assert/strict";
import {
  decodeTrevorEvent,
  events,
  PRODUCER_IDS,
  projectSessionId,
  SUPERVISOR_SESSION_ID,
  streamTransport,
  viewerIdentity,
} from "@belay/session";
import { bootStore } from "@belay/test-kit/boot";
import { afterEach, beforeEach, test } from "vitest";
import type { SupervisorDeps } from "../src/dispatch";
import { subscribeControlSession } from "../src/subscribe";

/**
 * The replay gate (plan 44.1 M3, simplify): the store replays the WHOLE control-session log on every
 * (re)connect. The supervisor must act ONLY on live requests - re-dispatching replayed history would
 * re-run past launches, re-pop folder dialogs, and duplicate results. This pins that a request already
 * in the log when the daemon subscribes is NOT dispatched, while a request that arrives live IS.
 */

let store: Awaited<ReturnType<typeof bootStore>>;
let transport: ReturnType<typeof streamTransport>;
let subscription: { stop: () => void } | undefined;

beforeEach(async () => {
  store = await bootStore();
  transport = streamTransport(store.url);
  await transport.ensureSession(SUPERVISOR_SESSION_ID);
});

afterEach(async () => {
  subscription?.stop();
  subscription = undefined;
  await store.close();
});

function publishRequest(requestId: string, root: string): Promise<void> {
  return transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.sessionLaunchRequested({ requestId, root }),
    producerId: PRODUCER_IDS.web,
  });
}

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

test("a request already in the replayed log is NOT dispatched; a live request is", async () => {
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

  // A request lands in the log BEFORE the supervisor subscribes - it will be replayed, not live.
  await publishRequest("replayed", "/old/app");

  await new Promise<void>((resolve) => {
    subscription = subscribeControlSession(transport, deps, {
      instanceId: "replay-test",
      onReplayComplete: resolve,
    });
  });

  // The replayed request must not have driven the launcher.
  assert.deepEqual(launched, [], "replayed request was not dispatched");

  // A request that arrives live IS dispatched.
  await publishRequest("live", "/new/app");
  const result = await awaitLaunchResult("live");
  assert.ok(result, "the live request produced a result");
  assert.deepEqual(launched, [{ sessionId: projectSessionId("/new/app"), root: "/new/app" }]);
});
