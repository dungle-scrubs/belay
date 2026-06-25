import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEvent, type SessionIdentity, streamTransport } from "@trevor/session";
import { afterEach, beforeEach, test } from "vitest";
import { createSessionStore } from "../src/server";

/**
 * Session substrate smoke gates beyond the transport conformance suite: the afterSeq replay
 * window, host-presence dedup on reconnect, durability across a store restart, and the
 * (deliberate) absence of wire idempotency. Boots its OWN server from ../src (no test-kit
 * dependency cycle). Guards the invariants host and web both lean on - ordered replay from a
 * cursor, real presence, a conversation that survives a restart, and "retried publish appends
 * again" (so clients must tolerate duplicates, never assume the wire dedupes).
 */

async function startStore(dbPath = ":memory:") {
  const server = createSessionStore(dbPath);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(predicate: () => boolean, label = "condition", timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const id = (
  instanceId: string,
  runtimeKind: string,
  participantId = instanceId,
): SessionIdentity => ({
  displayName: instanceId,
  runtimeKind,
  instanceId,
  participantId,
});

let store: Awaited<ReturnType<typeof startStore>>;

beforeEach(async () => {
  store = await startStore();
});

afterEach(async () => {
  await store.close();
});

test("a late joiner with afterSeq replays only events past the cursor", async () => {
  const transport = streamTransport(store.url);
  await transport.ensureSession("cursor");
  for (const text of ["a", "b", "c"]) {
    await transport.publishEvent("cursor", { type: text, producerId: "host", payload: {} });
  }

  const seen: SessionEvent[] = [];
  let replayed = false;
  const conn = transport.connectSession({
    sessionId: "cursor",
    identity: id("j", "test"),
    afterSeq: 1,
    onEvent: (e) => seen.push(e),
    onReplayComplete: () => {
      replayed = true;
    },
  });

  await waitFor(() => replayed && seen.length === 2, "afterSeq replay");
  assert.deepEqual(
    seen.map((e) => e.seq),
    [2, 3],
  );
  conn.close();
});

test("a host reconnecting (two sockets, one instanceId) is one presence entry", async () => {
  const transport = streamTransport(store.url);
  await transport.ensureSession("dedup");

  let presence: readonly { instanceId: string }[] | null = null;
  const viewer = transport.connectSession({
    sessionId: "dedup",
    identity: id("v", "web"),
    onEvent: () => {},
    onPresence: (hosts) => {
      presence = hosts.map((h) => ({ instanceId: h.instanceId }));
    },
  });
  await waitFor(() => presence !== null, "initial presence");

  // Same host instance (h1), two live sockets - a reconnect blip where the old socket
  // briefly overlaps the new one. Presence must collapse them to one entry.
  const sockA = transport.connectSession({
    sessionId: "dedup",
    identity: id("h1", "trevor", "a"),
    onEvent: () => {},
  });
  const sockB = transport.connectSession({
    sessionId: "dedup",
    identity: id("h1", "trevor", "b"),
    onEvent: () => {},
  });

  await waitFor(() => (presence?.length ?? 0) >= 1, "host present");
  assert.deepEqual(presence, [{ instanceId: "h1" }]);

  sockA.close();
  sockB.close();
  viewer.close();
});

test("publishing the same input twice appends twice (no wire idempotency)", async () => {
  const transport = streamTransport(store.url);
  await transport.ensureSession("dup");

  const events: SessionEvent[] = [];
  let replayed = false;
  const conn = transport.connectSession({
    sessionId: "dup",
    identity: id("w", "test"),
    onEvent: (e) => events.push(e),
    onReplayComplete: () => {
      replayed = true;
    },
  });
  await waitFor(() => replayed, "replay");

  const input = { type: "user.message", producerId: "web", payload: { text: "hi" } };
  await transport.publishEvent("dup", input);
  await transport.publishEvent("dup", input);

  await waitFor(() => events.length === 2, "two appends");
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2],
  );
  conn.close();
});

test("the durable log survives a store restart and replays from disk", async () => {
  await store.close(); // swap the in-memory store for an on-disk one a restart can reopen
  const dbPath = join(mkdtempSync(join(tmpdir(), "trevor-sessions-")), "sessions.db");

  store = await startStore(dbPath);
  const before = streamTransport(store.url);
  await before.ensureSession("persist");
  await before.publishEvent("persist", {
    type: "user.message",
    producerId: "web",
    payload: { text: "remember" },
  });
  await before.publishEvent("persist", {
    type: "assistant.completed",
    producerId: "host",
    payload: { text: "ok" },
  });
  await store.close();

  // Reboot against the same database file: replay must return the prior conversation.
  store = await startStore(dbPath);
  const after = streamTransport(store.url);
  const events: SessionEvent[] = [];
  let replayed = false;
  const conn = after.connectSession({
    sessionId: "persist",
    identity: id("reloader", "test"),
    onEvent: (e) => events.push(e),
    onReplayComplete: () => {
      replayed = true;
    },
  });
  await waitFor(() => replayed && events.length === 2, "replay after restart");
  assert.deepEqual(
    events.map((e) => e.type),
    ["user.message", "assistant.completed"],
  );
  conn.close();
});
