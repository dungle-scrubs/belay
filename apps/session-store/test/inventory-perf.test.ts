import assert from "node:assert/strict";
import { streamTransport } from "@trevor/session";
import { afterEach, beforeEach, test } from "vitest";
import { identity as id, inventoryById, startStore, waitForLiveHost } from "./support";

/**
 * The inventory read model over the wire (plan 45.1): GET /sessions is served from the in-memory
 * projection, so a create/append/delete must still be reflected on the very next request, with live
 * host presence folded in - and the served path must touch the durable SQLite log zero times once warm
 * (the transport-isolation guardrail: a poll can never again monopolize the event loop with a scan).
 * The delete-through-projection path is covered by delete-smoke, which now reads the projection too.
 */

let store: Awaited<ReturnType<typeof startStore>>;

beforeEach(async () => {
  store = await startStore();
});

afterEach(async () => {
  await store.close();
});

test("GET /sessions reflects a just-created session and a just-appended event next request", async () => {
  const transport = streamTransport(store.url);

  // Create: the session shows up empty (title falls back to the id, no events yet).
  await transport.ensureSession("s1");
  let byId = await inventoryById(store.url);
  assert.ok(byId.has("s1"), "created session appears in the inventory");
  assert.equal(byId.get("s1")?.eventCount, 0);
  assert.equal(byId.get("s1")?.title, "s1");

  // Append: the next GET reflects the new title + host fields + count, with no restart/rescan.
  await transport.publishEvent("s1", {
    type: "user.message",
    producerId: "web",
    payload: { text: "build the read model" },
  });
  await transport.publishEvent("s1", {
    type: "host.online",
    producerId: "host",
    payload: { instanceId: "h1", cwd: "~/dev/trevor", workspace: "~/dev/trevor" },
  });
  byId = await inventoryById(store.url);
  assert.equal(byId.get("s1")?.title, "build the read model");
  assert.equal(byId.get("s1")?.cwd, "~/dev/trevor");
  assert.equal(byId.get("s1")?.project, "trevor");
  assert.equal(byId.get("s1")?.eventCount, 2);

  // Live presence is folded in from the socket map, not the durable log.
  const host = transport.connectSession({
    sessionId: "s1",
    identity: id("h1", "trevor"),
    onEvent: () => {},
  });
  await waitForLiveHost(store.url, "s1");
  assert.equal((await inventoryById(store.url)).get("s1")?.host, "live");
  host.close();
});

test("GET /sessions issues zero SQLite queries once warm (the transport-isolation guardrail)", async () => {
  const transport = streamTransport(store.url);
  await transport.ensureSession("a");
  await transport.publishEvent("a", {
    type: "user.message",
    producerId: "web",
    payload: { text: "hi" },
  });
  await transport.ensureSession("b");

  // Snapshot the durable query counter AFTER seeding, then poll the inventory several times (the real
  // sidebar/resume 4s poll). The projection-served path must not touch SQLite at all - the counter is flat.
  const before = store.log.queries;
  await inventoryById(store.url);
  await inventoryById(store.url);
  await inventoryById(store.url);
  assert.equal(store.log.queries, before, "inventory polls touch SQLite zero times once warm");
});
