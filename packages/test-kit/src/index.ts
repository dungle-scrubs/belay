import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConnectSessionOptions,
  type DoctorArea,
  type DoctorAreaId,
  type DoctorSnapshot,
  type DoctorStatus,
  PRODUCER_IDS,
  type PublishInput,
  type SessionEvent,
  type SessionIdentity,
  type SessionSummary,
  type SessionTransport,
  type TrevorEventInput,
} from "@trevor/session";

/**
 * The generic test harness shared by every integration and e2e test (see repo-root AGENTS.md
 * "Testing"): the durable-log envelope + transport fixtures every test stamps, plus the async-poll
 * helper. These depend only on `@trevor/session`, so the web jsdom project can import them too; the
 * node-only store boot lifecycle (`bootStore`/`bootBlob`, which pulls in the store apps) lives in
 * the separate `@trevor/test-kit/boot` entry. Host-typed helpers (the fake provider, the turn
 * driver) live with the host under `apps/agent-host/test/support` so this package stays free of the
 * host's dependencies.
 */

/** A throwaway temp directory under the OS temp root. Caller removes it (or use `withTempDir`). */
export function tempDir(prefix = "trevor-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A `SessionIdentity` for a test participant. `runtimeKind` defaults to "test", which does NOT count
 *  as a host - only `RUNTIME_KIND.host` ("trevor") does - so a test participant stays a plain viewer
 *  unless it overrides the kind. */
export function testIdentity(id: string, runtimeKind = "test"): SessionIdentity {
  return { displayName: id, runtimeKind, instanceId: id, participantId: id };
}

/** The fixed timestamp every `storedEvent` stamps unless a test overrides `createdAt`. */
const STORED_EVENT_TIME = "2026-01-01T00:00:00.000Z";

/**
 * Stamps an `events.*` input (`{ type, payload }`) into the durable-log envelope the store appends
 * (`{ sessionId, seq, eventId, producerId, createdAt, type, payload }`), so a test never hand-spells
 * the envelope or drifts on its defaults. Defaults to seq 1 from the web producer; `over` sets any
 * field a test cares about (its own `producerId`/`createdAt`, or a specific `seq`/`sessionId`). The
 * canonical envelope is session-store's `EventLog.append`.
 */
export function storedEvent(input: TrevorEventInput, over?: Partial<SessionEvent>): SessionEvent {
  const seq = over?.seq ?? 1;
  return {
    sessionId: "test",
    seq,
    eventId: `e${seq}`,
    producerId: PRODUCER_IDS.web,
    createdAt: STORED_EVENT_TIME,
    type: input.type,
    payload: input.payload,
    ...over,
  };
}

/** Stamps a list of `events.*` inputs into a durable log, auto-sequencing `seq`/`eventId` from 1. */
export function storedLog(...inputs: readonly TrevorEventInput[]): SessionEvent[] {
  return inputs.map((input, index) => storedEvent(input, { seq: index + 1 }));
}

/** A recording in-memory `SessionTransport`: a fake backend that seeds replays and records writes. */
export interface RecordingTransport {
  readonly transport: SessionTransport;
  /** The sessionIds `ensureSession` was called with, in order. */
  readonly ensured: readonly string[];
  /** The `ConnectSessionOptions` of every open stream, so a test can drive its callbacks. */
  readonly connects: readonly ConnectSessionOptions[];
  /** The events published to `id`, in order (every write is recorded). */
  publishedBy(id: string): readonly PublishInput[];
  /** All events published across every session, in order. */
  readonly published: readonly PublishInput[];
  /** Seeds the durable log `connectSession` replays for `id` (then calls `onReplayComplete`). */
  seed(id: string, events: readonly SessionEvent[]): void;
  /** Sets the inventory `fetchInventory` returns. */
  setInventory(summaries: readonly SessionSummary[]): void;
  /** Makes `fetchInventory` reject with `error` (the "inventory unavailable" path). */
  failInventory(error: unknown): void;
}

/**
 * Builds an in-memory `SessionTransport` double for unit tests, replacing the four hand-rolled fakes
 * that each re-implemented the contract. `connectSession` replays a seeded log via `queueMicrotask`
 * then calls `onReplayComplete`, and drives `onStatus("open")` synchronously; every `ensureSession`
 * and `publishEvent` is recorded for assertions. `fetchInventory` returns the seeded inventory (empty
 * by default) or rejects when `failInventory` is set. The open stream options are exposed on
 * `connects` so a test can push `onEvent`/`onStatus`/`onReplayComplete` itself.
 */
export function recordingTransport(): RecordingTransport {
  const ensured: string[] = [];
  const connects: ConnectSessionOptions[] = [];
  const published = new Map<string, PublishInput[]>();
  const allPublished: PublishInput[] = [];
  const logs = new Map<string, readonly SessionEvent[]>();
  let inventory: readonly SessionSummary[] = [];
  let inventoryError: unknown;

  const transport: SessionTransport = {
    ensureSession: (id) => {
      ensured.push(id);
      return Promise.resolve(id);
    },
    publishEvent: (id, input) => {
      const list = published.get(id) ?? [];
      list.push(input);
      published.set(id, list);
      allPublished.push(input);
      return Promise.resolve();
    },
    connectSession: (options) => {
      connects.push(options);
      options.onStatus?.("open");
      const log = logs.get(options.sessionId) ?? [];
      queueMicrotask(() => {
        for (const event of log) {
          options.onEvent(event);
        }
        options.onReplayComplete?.();
      });
      return { close: () => {} };
    },
    fetchInventory: () =>
      inventoryError ? Promise.reject(inventoryError) : Promise.resolve(inventory),
  };

  return {
    transport,
    ensured,
    connects,
    published: allPublished,
    publishedBy: (id) => published.get(id) ?? [],
    seed: (id, events) => {
      logs.set(id, events);
    },
    setInventory: (summaries) => {
      inventory = summaries;
    },
    failInventory: (error) => {
      inventoryError = error;
    },
  };
}

/**
 * A `DoctorArea` fixture: the minimal area (`label` echoes `id`, empty `verdict`) with the `id`/`status`
 * a test names, plus any extra fields (facts/findings/nextAction) via `over`. Lets web tests, host tests,
 * the session protocol test, and the stories share one area vocabulary instead of re-spelling literals.
 */
export function doctorArea(
  id: DoctorAreaId,
  status: DoctorStatus,
  over?: Partial<DoctorArea>,
): DoctorArea {
  return { id, label: id, status, verdict: "", ...over };
}

/** A `DoctorSnapshot` fixture: a ready snapshot with no areas by default; `over` sets state/areas/host. */
export function doctorSnapshot(over?: Partial<DoctorSnapshot>): DoctorSnapshot {
  return { state: "ready", areas: [], ...over };
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
