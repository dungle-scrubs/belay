import type { AddressInfo } from "node:net";
import { type SessionIdentity, type SessionSummary, streamTransport } from "@trevor/session";
import { createSessionStore } from "../src/server";

/**
 * Shared harness for the session-store smoke tests: boot a store on an ephemeral port over a throwaway
 * db, build participant identities, and read/await the inventory. Local to the store package (not
 * `@trevor/test-kit`) so it can `import "../src/server"` without the test-kit/boot -> store cycle the
 * boot entry warns about.
 */

/** A store bound to an ephemeral port over a throwaway db (`:memory:` by default). Caller `close()`s it. */
export async function startStore(dbPath = ":memory:") {
  const server = createSessionStore(dbPath);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A participant identity; a "trevor" runtimeKind counts as a host, anything else is a plain viewer. */
export const identity = (
  instanceId: string,
  runtimeKind: string,
  participantId = instanceId,
): SessionIdentity => ({ displayName: instanceId, runtimeKind, instanceId, participantId });

/** The inventory read model (`GET /sessions`), keyed by sessionId. */
export async function inventoryById(url: string): Promise<Map<string, SessionSummary>> {
  const sessions = await streamTransport(url).fetchInventory();
  return new Map(sessions.map((s) => [s.sessionId, s]));
}

/** Polls the inventory until a session's host presence reads "live" (its host socket registered). */
export async function waitForLiveHost(
  url: string,
  sessionId: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await inventoryById(url)).get(sessionId)?.host !== "live") {
    if (Date.now() > deadline) throw new Error(`host presence for ${sessionId} did not reach live`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
