import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  type SessionEvent,
  type SessionIdentity,
  type SessionTransport,
  streamTransport,
} from "@trevor/session";
import { createSessionStore } from "./server";

/**
 * The transport conformance suite: drives the local session-store through the
 * shared `SessionTransport` contract (ensure -> publish -> replay-then-tail). The
 * same suite can later be pointed at Richter to prove the two backends behave
 * identically; for now it is the end-to-end proof that local-mode sessions work.
 */

const identity = (id: string): SessionIdentity => ({
  displayName: id,
  runtimeKind: "test",
  instanceId: id,
  participantId: id,
});

/** Polls until `predicate` holds or the timeout elapses (event callbacks are async). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A connected subscriber that records replay state and every event it receives. */
function subscriber(transport: SessionTransport, sessionId: string, who: string) {
  const events: SessionEvent[] = [];
  let replayed = false;
  const connection = transport.connectSession({
    sessionId,
    identity: identity(who),
    onEvent: (event) => events.push(event),
    onReplayComplete: () => {
      replayed = true;
    },
  });
  return { events, connection, isReplayed: () => replayed };
}

let server: ReturnType<typeof createSessionStore>;
let baseUrl: string;
let transport: SessionTransport;

before(async () => {
  server = createSessionStore(":memory:");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  transport = streamTransport(baseUrl);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("ensureSession is idempotent and returns the id", async () => {
  assert.equal(await transport.ensureSession("s1"), "s1");
  assert.equal(await transport.ensureSession("s1"), "s1");
});

test("a live subscriber tails published events in order with monotonic seq", async () => {
  await transport.ensureSession("live");
  const a = subscriber(transport, "live", "A");
  await waitFor(a.isReplayed); // empty replay completes immediately

  await transport.publishEvent("live", {
    type: "user.message",
    producerId: "web",
    payload: { text: "hi" },
  });
  await transport.publishEvent("live", {
    type: "assistant.delta",
    producerId: "host",
    payload: { text: "yo" },
  });
  await transport.publishEvent("live", {
    type: "assistant.completed",
    producerId: "host",
    payload: { text: "yo" },
  });

  await waitFor(() => a.events.length === 3);
  assert.deepEqual(
    a.events.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    a.events.map((e) => e.type),
    ["user.message", "assistant.delta", "assistant.completed"],
  );
  // The server fills the full SessionEvent shape, not just the published fields.
  assert.equal(a.events[0]?.sessionId, "live");
  assert.equal(a.events[0]?.producerId, "web");
  assert.equal(typeof a.events[0]?.eventId, "string");
  assert.equal(typeof a.events[0]?.createdAt, "string");

  a.connection.close();
});

test("a late joiner replays history (seq>after) then replay.complete, then tails live", async () => {
  await transport.ensureSession("replay");
  await transport.publishEvent("replay", { type: "a", producerId: "host", payload: {} });
  await transport.publishEvent("replay", { type: "b", producerId: "host", payload: {} });

  // Joins after the fact: must see the two prior events as replay, then complete.
  const b = subscriber(transport, "replay", "B");
  await waitFor(() => b.isReplayed() && b.events.length === 2);
  assert.deepEqual(
    b.events.map((e) => e.type),
    ["a", "b"],
  );

  // A third event after the join arrives live on the same connection.
  await transport.publishEvent("replay", { type: "c", producerId: "host", payload: {} });
  await waitFor(() => b.events.length === 3);
  assert.equal(b.events[2]?.type, "c");
  assert.equal(b.events[2]?.seq, 3);

  b.connection.close();
});

/**
 * A subscriber that records the latest live-host presence the backend pushes. `kind`
 * is the runtimeKind: "trevor" makes the connection count as a host, anything else
 * (a browser) only observes presence.
 */
function presenceWatcher(transport: SessionTransport, sessionId: string, id: string, kind: string) {
  let presence: readonly { instanceId: string }[] | null = null;
  const connection = transport.connectSession({
    sessionId,
    identity: { displayName: id, runtimeKind: kind, instanceId: id, participantId: id },
    onEvent: () => {},
    onPresence: (hosts) => {
      presence = hosts.map((host) => ({ instanceId: host.instanceId }));
    },
  });
  return { connection, latest: () => presence };
}

test("presence: a host connecting then disconnecting updates the live set viewers see", async () => {
  await transport.ensureSession("presence");

  // A viewer learns the (empty) live set as soon as it connects.
  const viewer = presenceWatcher(transport, "presence", "viewer", "web");
  await waitFor(() => viewer.latest() !== null);
  assert.deepEqual(viewer.latest(), []);

  // A host connecting pushes the new live set to the viewer.
  const host = presenceWatcher(transport, "presence", "host-1", "trevor");
  await waitFor(() => (viewer.latest()?.length ?? 0) === 1);
  assert.deepEqual(viewer.latest(), [{ instanceId: "host-1" }]);

  // The host's socket closing IS the disconnect: the viewer sees an empty live set
  // again, which a latched host.online event could never express.
  host.connection.close();
  await waitFor(() => (viewer.latest()?.length ?? 0) === 0);
  assert.deepEqual(viewer.latest(), []);

  viewer.connection.close();
});

test("two subscribers both receive a newly published event", async () => {
  await transport.ensureSession("fanout");
  const a = subscriber(transport, "fanout", "A");
  const b = subscriber(transport, "fanout", "B");
  await waitFor(() => a.isReplayed() && b.isReplayed());

  await transport.publishEvent("fanout", { type: "ping", producerId: "host", payload: {} });
  await waitFor(() => a.events.length === 1 && b.events.length === 1);
  assert.equal(a.events[0]?.type, "ping");
  assert.equal(b.events[0]?.type, "ping");

  a.connection.close();
  b.connection.close();
});
