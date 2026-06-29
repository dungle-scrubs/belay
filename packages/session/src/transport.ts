import type { HostPresence } from "./envelope";
import type { SessionEvent } from "./event";
import type { SessionSummary } from "./inventory";

/**
 * The session transport seam: the contract a participant uses to join a session,
 * receive its replay-then-tail event stream, and publish new events - independent
 * of where the durable log lives. The local session-store and a Richter service are
 * both reached through the one `streamTransport` implementation of this interface
 * (they speak the identical wire); selecting one is just the URL a deployment points
 * it at. The event shape (./event) and the trevor protocol (./protocol) are shared by
 * every transport.
 */

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Who this participant is on the stream. */
export interface SessionIdentity {
  readonly displayName: string;
  readonly runtimeKind: string;
  readonly instanceId: string;
  readonly participantId: string;
  readonly capabilities?: Record<string, unknown>;
}

/** One event to publish to the durable log: `{ type, producerId, payload }`. */
export interface PublishInput {
  readonly type: string;
  readonly producerId: string;
  readonly payload: Record<string, unknown>;
}

/** Options to open a replay-then-tail stream as a given participant identity. */
export interface ConnectSessionOptions {
  readonly sessionId: string;
  readonly identity: SessionIdentity;
  readonly afterSeq?: number;
  readonly onEvent: (event: SessionEvent) => void;
  readonly onReplayComplete?: () => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
  /**
   * The live host set, pushed by backends that track connections. Fires on connect
   * and whenever a host joins/leaves; never fires on a backend without presence
   * support, so callers treat "never fired" (vs. "fired empty") as unknown.
   */
  readonly onPresence?: (hosts: readonly HostPresence[]) => void;
}

/** A live stream handle; closing it detaches this participant. */
export interface SessionConnection {
  readonly close: () => void;
}

/**
 * A session backend: ensure a session exists, publish events to its durable log,
 * and open a replay-then-tail stream. One implementation per durable log (a local
 * store, the Richter service); participants depend on this interface, never on a
 * concrete backend.
 */
export interface SessionTransport {
  readonly ensureSession: (sessionId: string) => Promise<string>;
  readonly publishEvent: (sessionId: string, input: PublishInput) => Promise<void>;
  readonly connectSession: (options: ConnectSessionOptions) => SessionConnection;
  /**
   * The session inventory read model (`GET /sessions`): every durable session's summary. Owned by
   * the transport beside its sibling `/sessions` routes so the resume chooser, sidebar, cli, and
   * recall reader stop each hand-rolling the fetch + `{ sessions }` envelope guard. Throws on a
   * non-OK response; an optional `AbortSignal` cancels the in-flight request (the web polls it).
   */
  readonly fetchInventory: (signal?: AbortSignal) => Promise<readonly SessionSummary[]>;
}
