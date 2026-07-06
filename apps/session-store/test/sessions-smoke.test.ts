import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEvent, streamTransport } from "@trevor/session";
import { afterEach, beforeEach, test } from "vitest";
import { WebSocket } from "ws";
import { BREAKER_COOLDOWN_MS, QUERY_BUDGET_MS } from "../src/log";
import { identity as id, inventoryById, startStore, waitForLiveHost } from "./support";

/**
 * Session substrate smoke gates beyond the transport conformance suite: the afterSeq replay
 * window, host-presence dedup on reconnect, durability across a store restart, and the
 * (deliberate) absence of wire idempotency. Boots its OWN server from ../src (no test-kit
 * dependency cycle). Guards the invariants host and web both lean on - ordered replay from a
 * cursor, real presence, a conversation that survives a restart, and "retried publish appends
 * again" (so clients must tolerate duplicates, never assume the wire dedupes).
 */

async function waitFor(predicate: () => boolean, label = "condition", timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

test("GET /sessions returns the inventory read model with live presence folded in", async () => {
  const transport = streamTransport(store.url);
  // Two sessions: one with a user message + a live host, one bare (no host ever).
  await transport.ensureSession("with-host");
  await transport.publishEvent("with-host", {
    type: "user.message",
    producerId: "web",
    payload: { text: "build the inventory" },
  });
  await transport.publishEvent("with-host", {
    type: "host.online",
    producerId: "host",
    payload: { instanceId: "h1", cwd: "~/dev/trevor", workspace: "~/dev/trevor" },
  });
  await transport.ensureSession("bare");

  // A live host socket on "with-host" so presence reads "live".
  const host = transport.connectSession({
    sessionId: "with-host",
    identity: id("h1", "trevor"),
    onEvent: () => {},
  });

  // Wait until the host socket has registered as live presence, then read the inventory.
  await waitForLiveHost(store.url, "with-host");
  const byId = await inventoryById(store.url);

  const withHost = byId.get("with-host");
  assert.equal(withHost?.title, "build the inventory");
  assert.equal(withHost?.cwd, "~/dev/trevor");
  assert.equal(withHost?.project, "trevor");
  assert.equal(withHost?.host, "live");

  const bare = byId.get("bare");
  assert.equal(bare?.host, "none");
  assert.equal(bare?.title, "bare");

  host.close();
});

test("GET /diag returns the store diagnostic payload without changing /health", async () => {
  const res = await fetch(`${store.url}/diag`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    readonly indexHealthy?: unknown;
    readonly queries?: unknown;
    readonly schemaVersion?: unknown;
    readonly slowQueries?: unknown;
    readonly startupSha?: unknown;
  };
  assert.equal(body.indexHealthy, true);
  assert.equal(typeof body.queries, "number");
  assert.equal(typeof body.schemaVersion, "number");
  assert.equal(typeof body.slowQueries, "number");
  assert.ok(typeof body.startupSha === "string" || body.startupSha === null);

  const health = await fetch(`${store.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
});

test("an open circuit degrades to typed 503s and a 1013 stream close; /health, /diag and GET /sessions stay up; the cooldown heals it", async () => {
  await store.close(); // swap the default store for one whose query/breaker clock is hand-cranked
  let time = 0;
  let step = 0;
  const now = () => {
    const value = time;
    time += step;
    return value;
  };
  store = await startStore(":memory:", { now });

  const transport = streamTransport(store.url);
  await transport.ensureSession("cb");

  // Trip the breaker: the next write's statements run over budget. The tripping write itself still
  // lands (post-slow-query policy: an admitted operation always completes) - only later ops fast-fail.
  step = QUERY_BUDGET_MS + 100;
  await transport.publishEvent("cb", {
    type: "user.message",
    producerId: "web",
    payload: { text: "trip" },
  });
  step = 0;

  // While open: reads and writes through the gated log fast-fail as typed 503s - never a crash/400/500.
  const create = await fetch(`${store.url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "rejected" }),
  });
  assert.equal(create.status, 503);
  const overloaded = (await create.json()) as { error?: string; retryAfterMs?: number };
  assert.equal(overloaded.error, "store overloaded");
  assert.ok((overloaded.retryAfterMs ?? 0) > 0, "the 503 carries the remaining cooldown");

  const publish = await fetch(`${store.url}/sessions/cb/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "user.message", producerId: "web", payload: {} }),
  });
  assert.equal(publish.status, 503);

  const purge = await fetch(`${store.url}/sessions/cb/delete`, { method: "POST" });
  assert.equal(purge.status, 503);

  // A joining stream replays through the gated log: refused gracefully with 1013 "Try Again Later".
  const closedWith = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${store.url.replace("http", "ws")}/sessions/cb/stream`);
    socket.on("close", (code) => resolve(code));
    socket.on("error", reject);
  });
  assert.equal(closedWith, 1013);

  // Liveness, the drift doctor, and the in-memory inventory never route through the gated log.
  assert.equal((await fetch(`${store.url}/health`)).status, 200);
  assert.equal((await fetch(`${store.url}/diag`)).status, 200);
  assert.equal((await fetch(`${store.url}/sessions`)).status, 200);

  // After the cooldown the half-open probe closes the circuit and normal service resumes.
  time += BREAKER_COOLDOWN_MS;
  const healed = await fetch(`${store.url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "healed" }),
  });
  assert.equal(healed.status, 200);
  await transport.publishEvent("cb", { type: "user.message", producerId: "web", payload: {} });
});

test("a slow startup warm scan never boots the store into a 503 window: the first write is admitted", async () => {
  await store.close(); // swap in a store whose CONSTRUCTION-time warm scan runs over budget
  let time = 0;
  let step = QUERY_BUDGET_MS + 100; // every boot-time statement (incl. the warm scan) is over budget
  const now = () => {
    const value = time;
    time += step;
    return value;
  };
  store = await startStore(":memory:", { now });
  step = 0;

  // The regression this pins (plan 45.2 review fix): pre-fix, the warm scan tripped the breaker at
  // construction, so every write 503'd (and WS replays 1013'd) for the first cooldown after each
  // restart. The warm scan is breaker-exempt, so the very first post-boot write must be admitted.
  const create = await fetch(`${store.url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "boot" }),
  });
  assert.equal(create.status, 200, "the first post-boot write succeeds immediately, never 503");

  const publish = await fetch(`${store.url}/sessions/boot/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "user.message", producerId: "web", payload: {} }),
  });
  assert.equal(publish.status, 201, "the first event append also lands");
});
