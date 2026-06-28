import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SessionEvent,
  type SessionIdentity,
  type SessionTransport,
  streamTransport,
} from "@trevor/session";

/**
 * The generic test harness shared by every integration and e2e test (see repo-root
 * AGENTS.md "Testing"): boot a real session-store / blob-store on an ephemeral port
 * against a throwaway backing store, build a transport, and poll for async conditions.
 * The listen/teardown lifecycle is @trevor/server-kit's `startServer` (the same path
 * production binds through); this harness just supplies the throwaway backing store and
 * its cleanup. Host-typed helpers (the fake provider, the turn driver) live with the
 * host under `apps/agent-host/test/support` so this package stays free of the host's
 * dependencies.
 */

/** A throwaway temp directory under the OS temp root. Caller removes it (or use `withTempDir`). */
export function tempDir(prefix = "trevor-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A `SessionIdentity` for a test participant; `runtimeKind` "trevor" makes it count as a host. */
export function testIdentity(id: string, runtimeKind = "test"): SessionIdentity {
  return { displayName: id, runtimeKind, instanceId: id, participantId: id };
}

/** The shared session transport, pointed at a booted store (or any `/sessions` backend). */
export function testTransport(url: string): SessionTransport {
  return streamTransport(url);
}

/** Poll until `predicate` holds or the timeout elapses; event callbacks are async. */
export async function waitFor(
  predicate: () => boolean,
  opts?: { readonly timeoutMs?: number; readonly label?: string },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: ${opts?.label ?? "condition"} not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A connected subscriber that records replay state and every event it receives. */
export function subscribe(transport: SessionTransport, sessionId: string, who: string) {
  const events: SessionEvent[] = [];
  let replayed = false;
  const connection = transport.connectSession({
    sessionId,
    identity: testIdentity(who),
    onEvent: (event) => events.push(event),
    onReplayComplete: () => {
      replayed = true;
    },
  });
  return { events, connection, isReplayed: () => replayed };
}
