import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { type SessionIdentity, type SessionSummary, streamTransport } from "@trevor/session";
import { afterEach, beforeEach, test } from "vitest";
import { createSessionStore } from "../src/server";

/**
 * Permanent-delete gate (plan 04): the store is the authoritative arbiter of `POST /sessions/<id>/delete`,
 * the destructive purge distinct from the soft-delete `session.deleted` marker. These gates prove the
 * happy path (an archived, settled, host-less session is removed for good and never reappears in the
 * inventory) and that every precondition rejection (missing, not-archived, live host) comes back as a
 * typed `{ ok: false }` body rather than a thrown transport error or an actual delete.
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

const id = (instanceId: string, runtimeKind: string): SessionIdentity => ({
  displayName: instanceId,
  runtimeKind,
  instanceId,
  participantId: instanceId,
});

let store: Awaited<ReturnType<typeof startStore>>;

beforeEach(async () => {
  store = await startStore();
});

afterEach(async () => {
  await store.close();
});

/** Marks a session archived (the latest session.archived event wins). */
async function archive(url: string, sessionId: string): Promise<void> {
  const transport = streamTransport(url);
  await transport.ensureSession(sessionId);
  await transport.publishEvent(sessionId, {
    type: "session.archived",
    producerId: "trevor-web",
    payload: { archived: true },
  });
}

async function inventoryById(url: string): Promise<Map<string, SessionSummary>> {
  const res = await fetch(`${url}/sessions`);
  const body = (await res.json()) as { sessions: SessionSummary[] };
  return new Map(body.sessions.map((s) => [s.sessionId, s]));
}

test("an archived, settled, host-less session is permanently deleted and never reappears", async () => {
  const transport = streamTransport(store.url);
  await archive(store.url, "purge-me");
  // A second bystander session stays untouched, proving the delete is targeted.
  await transport.ensureSession("keep-me");

  assert.ok(
    (await inventoryById(store.url)).has("purge-me"),
    "archived session present before delete",
  );

  const result = await transport.permanentlyDeleteSession("purge-me");
  assert.deepEqual(result, { ok: true, sessionId: "purge-me" });

  const after = await inventoryById(store.url);
  assert.ok(!after.has("purge-me"), "deleted session is gone from the inventory");
  assert.ok(after.has("keep-me"), "the bystander session is untouched");
});

test("a missing session is rejected not-found (404) without throwing", async () => {
  const transport = streamTransport(store.url);
  const result = await transport.permanentlyDeleteSession("ghost");
  assert.deepEqual(result, {
    ok: false,
    reason: "not-found",
    detail: "session not found",
  });
});

test("a non-archived session is rejected not-archived and is not deleted", async () => {
  const transport = streamTransport(store.url);
  await transport.ensureSession("live-one");
  await transport.publishEvent("live-one", {
    type: "user.message",
    producerId: "trevor-web",
    payload: { text: "still working" },
  });

  const result = await transport.permanentlyDeleteSession("live-one");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not-archived");
  assert.ok((await inventoryById(store.url)).has("live-one"), "rejected session is still present");
});

test("an archived session with a live host is protected from delete", async () => {
  const transport = streamTransport(store.url);
  await archive(store.url, "hosted");

  const host = transport.connectSession({
    sessionId: "hosted",
    identity: id("h1", "trevor"),
    onEvent: () => {},
  });
  // Wait until the host socket registers as live presence on the inventory.
  let byId = await inventoryById(store.url);
  const deadline = Date.now() + 2000;
  while (byId.get("hosted")?.host !== "live") {
    if (Date.now() > deadline) throw new Error("host presence did not reach live");
    await new Promise((r) => setTimeout(r, 20));
    byId = await inventoryById(store.url);
  }

  const result = await transport.permanentlyDeleteSession("hosted");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "protected");
  assert.ok((await inventoryById(store.url)).has("hosted"), "protected session is still present");

  host.close();
});
