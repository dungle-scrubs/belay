import assert from "node:assert/strict";
import { test } from "vitest";
import { hostIdentity, type SessionTransport, viewerIdentity } from "../src/index";
import { subscribe, waitFor } from "../src/testing";

/**
 * The transport conformance suite: the reusable contract every `SessionTransport`
 * backend must satisfy (ensure -> publish -> replay-then-tail -> presence -> fan-out).
 * It is owned HERE, by the protocol package, not by any one implementor - the caller
 * provides a freshly-booted transport and this file owns the assertions. The local
 * session-store runs it hermetically (apps/session-store/test); Tether runs the very
 * same suite against a live service (tether-transport.test.ts here, gated on TETHER_URL),
 * so the two backends are proven identical rather than merely similar.
 */

export interface ConformanceContext {
  /** The booted transport under test - the same instance for every case in the suite. */
  transport(): SessionTransport;
}

/** Records the latest live-host presence the backend pushes; `kind` "belay" counts as a host. */
function presenceWatcher(transport: SessionTransport, sessionId: string, id: string, kind: string) {
  let presence: readonly { instanceId: string }[] | null = null;
  const subscriber = subscribe(transport, sessionId, id, {
    identity:
      kind === "belay"
        ? hostIdentity({ displayName: id, instanceId: id, participantId: id })
        : viewerIdentity({ displayName: id, instanceId: id, participantId: id }),
    onPresence: (hosts) => {
      presence = hosts.map((host) => ({ instanceId: host.instanceId }));
    },
  });
  return { connection: subscriber.connection, latest: () => presence };
}

export function runTransportConformance(ctx: ConformanceContext): void {
  test("ensureSession is idempotent and returns the id", async () => {
    const transport = ctx.transport();
    assert.equal(await transport.ensureSession("s1"), "s1");
    assert.equal(await transport.ensureSession("s1"), "s1");
  });

  test("a live subscriber tails published events in order with monotonic seq", async () => {
    const transport = ctx.transport();
    await transport.ensureSession("live");
    const a = subscribe(transport, "live", "A");
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
    const transport = ctx.transport();
    await transport.ensureSession("replay");
    await transport.publishEvent("replay", { type: "a", producerId: "host", payload: {} });
    await transport.publishEvent("replay", { type: "b", producerId: "host", payload: {} });

    // Joins after the fact: must see the two prior events as replay, then complete.
    const b = subscribe(transport, "replay", "B");
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

  test("presence: a host connecting then disconnecting updates the live set viewers see", async () => {
    const transport = ctx.transport();
    await transport.ensureSession("presence");

    // A viewer learns the (empty) live set as soon as it connects.
    const viewer = presenceWatcher(transport, "presence", "viewer", "web");
    await waitFor(() => viewer.latest() !== null);
    assert.deepEqual(viewer.latest(), []);

    // A host connecting pushes the new live set to the viewer.
    const host = presenceWatcher(transport, "presence", "host-1", "belay");
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
    const transport = ctx.transport();
    await transport.ensureSession("fanout");
    const a = subscribe(transport, "fanout", "A");
    const b = subscribe(transport, "fanout", "B");
    await waitFor(() => a.isReplayed() && b.isReplayed());

    await transport.publishEvent("fanout", { type: "ping", producerId: "host", payload: {} });
    await waitFor(() => a.events.length === 1 && b.events.length === 1);
    assert.equal(a.events[0]?.type, "ping");
    assert.equal(b.events[0]?.type, "ping");

    a.connection.close();
    b.connection.close();
  });
}
