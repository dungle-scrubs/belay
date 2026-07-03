import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import type { ConnectSessionOptions, SessionConnection, SessionTransport } from "./transport";
import { awaitSessionEvent, readSessionLog } from "./transport";

const event = (seq: number, type = "event"): SessionEvent => ({
  sessionId: "s",
  seq,
  eventId: `e-${seq}`,
  producerId: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
  type,
  payload: {},
});

function fakeTransport(
  connect: (options: ConnectSessionOptions) => SessionConnection,
): SessionTransport {
  const transport: SessionTransport = {
    ensureSession: async (sessionId) => sessionId,
    publishEvent: async () => {},
    connectSession: connect,
    readLog: (sessionId, identity, options) =>
      readSessionLog(transport, sessionId, identity, options),
    awaitEvent: (sessionId, identity, predicate, options) =>
      awaitSessionEvent(transport, sessionId, identity, predicate, options),
    fetchInventory: async () => [],
    permanentlyDeleteSession: async (sessionId) => ({ ok: true, sessionId }),
  };
  return transport;
}

const identity = {
  displayName: "reader",
  runtimeKind: "web",
  instanceId: "reader-1",
  participantId: "reader-1",
};

test("readSessionLog resolves replayed events and closes the stream", async () => {
  let closed = false;
  const transport = fakeTransport((options) => {
    queueMicrotask(() => {
      options.onEvent(event(1, "a"));
      options.onEvent(event(2, "b"));
      options.onReplayComplete?.();
    });
    return {
      close: () => {
        closed = true;
      },
    };
  });

  const log = await transport.readLog("s", identity);

  assert.deepEqual(
    log.map((item) => item.type),
    ["a", "b"],
  );
  assert.equal(closed, true);
});

test("readSessionLog rejects when the stream closes before replay completes", async () => {
  const transport = fakeTransport((options) => {
    queueMicrotask(() => options.onStatus?.("closed"));
    return { close: () => {} };
  });

  await assert.rejects(
    () => transport.readLog("s", identity, { timeoutMs: 50 }),
    /socket closed before replay completed/,
  );
});

test("awaitSessionEvent resolves the matching event and closes the stream", async () => {
  let closed = false;
  const transport = fakeTransport((options) => {
    queueMicrotask(() => {
      options.onEvent(event(1, "skip"));
      options.onEvent(event(2, "match"));
      options.onEvent(event(3, "late"));
    });
    return {
      close: () => {
        closed = true;
      },
    };
  });

  const matched = await transport.awaitEvent("s", identity, (item) => item.type === "match");

  assert.equal(matched?.seq, 2);
  assert.equal(closed, true);
});

test("awaitSessionEvent resolves null on timeout", async () => {
  const transport = fakeTransport(() => ({ close: () => {} }));

  const matched = await transport.awaitEvent("s", identity, () => false, { timeoutMs: 1 });

  assert.equal(matched, null);
});
