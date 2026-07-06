import type { HostPresence } from "./envelope";
import type { SessionEvent } from "./event";
import type { SessionSummary } from "./inventory";
import type { PermanentDeleteResult } from "./session-delete";

/**
 * The session transport seam: the contract a participant uses to join a session,
 * receive its replay-then-tail event stream, and publish new events - independent
 * of where the durable log lives. The local session-store and a Tether service are
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

export interface ReadLogOptions {
  readonly afterSeq?: number;
  readonly timeoutMs?: number;
}

export type AwaitEventOptions = ReadLogOptions;

const DEFAULT_READ_TIMEOUT_MS = 2_000;

/** The stream handlers a {@link streamMachine} caller supplies: what to do per event, on replay
 *  completion (optional - `awaitSessionEvent` has no replay terminal), on a `closed` status, and on the
 *  timeout. Each terminal calls the `settle` the machine hands them so the outcome runs exactly once. */
interface StreamHandlers {
  readonly onEvent: (event: SessionEvent) => void;
  readonly onReplayComplete?: () => void;
  readonly onClosed: () => void;
  readonly onTimeout: () => void;
}

/** What a {@link streamMachine} caller's `build` receives: the idempotent `settle`, the growing event
 *  buffer, and the machine's own `resolve`/`reject` to fold into terminal outcomes. */
interface StreamMachineContext<T> {
  readonly settle: (outcome: () => void) => void;
  readonly collected: SessionEvent[];
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The one replay/timeout/close Promise machine `readSessionLog` and `awaitSessionEvent` are both built
 * on: it opens a `connectSession` stream, guarantees EXACTLY ONE settlement, always closes the stream
 * before resolving, and handles the close-before-connected race - the subtle bits neither caller should
 * reimplement. `build` returns the terminal handlers; each caller supplies only which outcome each
 * terminal produces (resolve the log / resolve the match / reject vs. resolve-null on timeout).
 */
function streamMachine<T>(
  transport: Pick<SessionTransport, "connectSession">,
  sessionId: string,
  identity: SessionIdentity,
  afterSeq: number,
  timeoutMs: number,
  build: (ctx: StreamMachineContext<T>) => StreamHandlers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const collected: SessionEvent[] = [];
    let connection: SessionConnection | null = null;
    let closeWhenConnected = false;
    let settled = false;

    const close = (): void => {
      if (connection === null) {
        closeWhenConnected = true;
        return;
      }
      connection.close();
    };

    const settle = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      close();
      outcome();
    };

    const handlers = build({ settle, collected, resolve, reject });
    const timer = setTimeout(handlers.onTimeout, timeoutMs);

    connection = transport.connectSession({
      sessionId,
      identity,
      afterSeq,
      onEvent: handlers.onEvent,
      onReplayComplete: handlers.onReplayComplete,
      onStatus: (status) => {
        if (status === "closed") {
          handlers.onClosed();
        }
      },
    });

    if (closeWhenConnected) {
      connection.close();
    }
  });
}

/**
 * Opens a read-only replay stream, resolves with the replayed log, then closes the stream. This owns
 * the transport-level replay/timeout/closed-before-replay choreography so callers do not reimplement
 * a Promise machine around `connectSession`.
 */
export function readSessionLog(
  transport: Pick<SessionTransport, "connectSession">,
  sessionId: string,
  identity: SessionIdentity,
  options: ReadLogOptions = {},
): Promise<readonly SessionEvent[]> {
  return streamMachine<readonly SessionEvent[]>(
    transport,
    sessionId,
    identity,
    options.afterSeq ?? 0,
    options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    ({ settle, collected, resolve, reject }) => ({
      onEvent: (event) => collected.push(event),
      onReplayComplete: () => settle(() => resolve(collected)),
      onClosed: () => settle(() => reject(new Error("socket closed before replay completed"))),
      onTimeout: () => settle(() => reject(new Error("read timed out"))),
    }),
  );
}

/**
 * Opens a replay-then-tail stream until `predicate` accepts an event or the timeout expires. The
 * stream is always closed before this resolves.
 */
export function awaitSessionEvent(
  transport: Pick<SessionTransport, "connectSession">,
  sessionId: string,
  identity: SessionIdentity,
  predicate: (event: SessionEvent) => boolean,
  options: AwaitEventOptions = {},
): Promise<SessionEvent | null> {
  return streamMachine<SessionEvent | null>(
    transport,
    sessionId,
    identity,
    options.afterSeq ?? 0,
    options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    ({ settle, resolve }) => ({
      onEvent: (event) => {
        if (predicate(event)) {
          settle(() => resolve(event));
        }
      },
      onClosed: () => settle(() => resolve(null)),
      onTimeout: () => settle(() => resolve(null)),
    }),
  );
}

/**
 * A session backend: ensure a session exists, publish events to its durable log,
 * and open a replay-then-tail stream. One implementation per durable log (a local
 * store, the Tether service); participants depend on this interface, never on a
 * concrete backend.
 */
export interface SessionTransport {
  readonly ensureSession: (sessionId: string) => Promise<string>;
  readonly publishEvent: (sessionId: string, input: PublishInput) => Promise<void>;
  readonly connectSession: (options: ConnectSessionOptions) => SessionConnection;
  readonly readLog: (
    sessionId: string,
    identity: SessionIdentity,
    options?: ReadLogOptions,
  ) => Promise<readonly SessionEvent[]>;
  readonly awaitEvent: (
    sessionId: string,
    identity: SessionIdentity,
    predicate: (event: SessionEvent) => boolean,
    options?: AwaitEventOptions,
  ) => Promise<SessionEvent | null>;
  /**
   * The session inventory read model (`GET /sessions`): every durable session's summary. Owned by
   * the transport beside its sibling `/sessions` routes so the resume chooser, sidebar, cli, and
   * recall reader stop each hand-rolling the fetch + `{ sessions }` envelope guard. Throws on a
   * non-OK response; an optional `AbortSignal` cancels the in-flight request (the web polls it).
   */
  readonly fetchInventory: (signal?: AbortSignal) => Promise<readonly SessionSummary[]>;
  /**
   * Permanently deletes an archived session's durable storage (plan 04) - distinct from the soft-delete
   * `session.deleted` event. Returns a typed {@link PermanentDeleteResult}: the backend is the
   * authoritative gate (rejecting a non-archived / protected / missing session), so this resolves with
   * the rejection rather than throwing on a precondition failure; it throws only on a transport error.
   */
  readonly permanentlyDeleteSession: (sessionId: string) => Promise<PermanentDeleteResult>;
}
