import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobServer } from "@trevor/blob-store/server";
import {
  type SessionEvent,
  type SessionIdentity,
  type SessionTransport,
  streamTransport,
} from "@trevor/session";
import { createSessionStore } from "@trevor/session-store/server";

/**
 * The generic test harness shared by every integration and e2e test (see repo-root
 * AGENTS.md "Testing"): boot a real session-store / blob-store on an ephemeral port
 * against a throwaway backing store, build a transport, and poll for async conditions.
 * It owns lifecycle so a test never hardcodes a port or leaks a temp dir. Host-typed
 * helpers (the fake provider, the turn driver) live with the host under
 * `apps/agent-host/test/support` so this package stays free of the host's dependencies.
 */

const DEFAULT_BLOB_MAX_BYTES = 25 * 1024 * 1024;

/** A service bound to an ephemeral loopback port, with its own teardown. */
export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function startHttp(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Boot a session-store on an ephemeral port. Defaults to an in-memory SQLite database;
 * pass a file path to exercise on-disk persistence (e.g. a restart test).
 */
export async function startSessionStore(dbPath = ":memory:"): Promise<RunningServer> {
  const server = createSessionStore(dbPath);
  const port = await startHttp(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => closeHttp(server),
  };
}

/**
 * Boot a blob-store on an ephemeral port over a throwaway directory (removed on close
 * unless a `root` is supplied). `maxBytes` defaults to the production 25MB ceiling.
 */
export async function startBlobStore(opts?: {
  readonly root?: string;
  readonly maxBytes?: number;
}): Promise<RunningServer> {
  const ownsRoot = opts?.root === undefined;
  const root = opts?.root ?? mkdtempSync(join(tmpdir(), "trevor-blob-"));
  const server = createBlobServer(root, opts?.maxBytes ?? DEFAULT_BLOB_MAX_BYTES);
  const port = await startHttp(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      await closeHttp(server);
      if (ownsRoot) {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

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
