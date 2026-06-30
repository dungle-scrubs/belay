import assert from "node:assert/strict";
import type { RunningServer } from "@trevor/server-kit";
import { archivedSessions, type SessionSummary, streamTransport } from "@trevor/session";
import { bootStore } from "@trevor/test-kit/boot";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-ARCHIVE (plan 04): the archive-browser data flow end-to-end against the real booted session-store,
 * through the exact contract the web surface uses - the inventory read model + `archivedSessions`
 * projection for discovery, the `session.archived` publish for archive/unarchive, and the
 * `permanentlyDeleteSession` purge with its typed gate. Proves a purged session never reappears after
 * a fresh inventory fetch, and that the destructive gate rejects the cases the UI must not allow.
 */

let store: RunningServer;

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  await store.close();
});

const transport = () => streamTransport(store.url);

/** The current inventory keyed by sessionId. */
async function inventory(): Promise<Map<string, SessionSummary>> {
  const sessions = await transport().fetchInventory();
  return new Map(sessions.map((s) => [s.sessionId, s]));
}

/** Creates a session, gives it a title, and archives it - a discoverable archive-browser row. */
async function seedArchived(t: ReturnType<typeof transport>, sessionId: string): Promise<void> {
  await t.ensureSession(sessionId);
  await t.publishEvent(sessionId, {
    type: "user.message",
    producerId: "trevor-web",
    payload: { text: `work on ${sessionId}` },
  });
  await t.publishEvent(sessionId, {
    type: "session.archived",
    producerId: "trevor-web",
    payload: { archived: true },
  });
}

test("an archived session is discoverable through the inventory's archived projection", async () => {
  const t = transport();
  await seedArchived(t, "discover-me");
  await t.ensureSession("active-one"); // a non-archived bystander

  const sessions = await t.fetchInventory();
  const archived = archivedSessions(sessions).map((s) => s.sessionId);
  assert.ok(archived.includes("discover-me"), "archived session is in the archive projection");
  assert.ok(!archived.includes("active-one"), "a normal session is not in the archive projection");
});

test("unarchive clears the flag so the session leaves the archive projection", async () => {
  const t = transport();
  await seedArchived(t, "restore-me");
  assert.equal((await inventory()).get("restore-me")?.archived, true);

  // The web unarchive action: republish session.archived with archived:false (latest wins).
  await t.publishEvent("restore-me", {
    type: "session.archived",
    producerId: "trevor-web",
    payload: { archived: false },
  });

  const sessions = await t.fetchInventory();
  assert.equal(
    sessions.find((s) => s.sessionId === "restore-me")?.archived,
    false,
    "the flag is cleared",
  );
  assert.ok(
    !archivedSessions(sessions).some((s) => s.sessionId === "restore-me"),
    "it has left the archive projection",
  );
});

test("permanently deleting an archived session removes it for good (never reappears)", async () => {
  const t = transport();
  await seedArchived(t, "purge-me");

  const result = await t.permanentlyDeleteSession("purge-me");
  assert.deepEqual(result, { ok: true, sessionId: "purge-me" });

  // A FRESH inventory fetch must not list it - the purge is durable, not a hidden flag.
  assert.ok(!(await inventory()).has("purge-me"), "purged session is gone from the inventory");
});

test("the destructive gate rejects a non-archived session (not-archived)", async () => {
  const t = transport();
  await t.ensureSession("not-archived");
  await t.publishEvent("not-archived", {
    type: "user.message",
    producerId: "trevor-web",
    payload: { text: "keep me" },
  });

  const result = await t.permanentlyDeleteSession("not-archived");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not-archived");
  }
  assert.ok((await inventory()).has("not-archived"), "the rejected session is untouched");
});

test("the destructive gate rejects a missing session (not-found)", async () => {
  const result = await transport().permanentlyDeleteSession("ghost-session");
  assert.deepEqual(result, { ok: false, reason: "not-found", detail: "session not found" });
});

test("the destructive gate protects an archived session with a live host", async () => {
  const t = transport();
  await seedArchived(t, "hosted");

  // A live host socket on the session makes its presence read "live", which protects the purge.
  const host = t.connectSession({
    sessionId: "hosted",
    identity: {
      displayName: "h",
      runtimeKind: "trevor",
      instanceId: "h1",
      participantId: "h1",
    },
    onEvent: () => {},
  });
  const deadline = Date.now() + 2000;
  while ((await inventory()).get("hosted")?.host !== "live") {
    if (Date.now() > deadline) throw new Error("host presence did not reach live");
    await new Promise((r) => setTimeout(r, 20));
  }

  const result = await t.permanentlyDeleteSession("hosted");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "protected");
  }
  assert.ok((await inventory()).has("hosted"), "the protected session is untouched");

  host.close();
});
