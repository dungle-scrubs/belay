import type { ConnectSessionOptions, SessionConnection } from "@belay/session";
import type { TrevorClient } from "./client";

/**
 * The stream-result lifecycle both `streamTurn` and `runCommand` are built on: open a `connectSession`
 * tail stream as the client's identity, arm a timeout, and guarantee EXACTLY ONE settlement that always
 * closes the stream first (and never double-resolves). The subtle bits - the settle-once guard, closing
 * on every exit path, clearing the timer, and routing a synchronous `connectSession` throw through the
 * same settle - live here once, so a caller can't leak a socket or double-settle by getting them wrong.
 *
 * The caller supplies only what differs: `build` returns the stream handlers (given the idempotent
 * `settle` plus `resolve`/`reject` to fold into terminal outcomes), and `onTimeout` decides what the
 * deadline produces (a resolved "timed out" result, or a rejection).
 */
export interface StreamResultContext<T> {
  /** Runs `finalize` exactly once, after clearing the timer and closing the stream. Later calls no-op. */
  readonly settle: (finalize: () => void) => void;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

type StreamHandlers = Pick<ConnectSessionOptions, "onEvent" | "onReplayComplete" | "onStatus">;

export function awaitStreamResult<T>(
  client: TrevorClient,
  connect: { readonly sessionId: string; readonly afterSeq?: number },
  timeoutMs: number,
  build: (ctx: StreamResultContext<T>) => StreamHandlers,
  onTimeout: (ctx: StreamResultContext<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let connection: SessionConnection | null = null;
    let settled = false;

    const settle = (finalize: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      connection?.close();
      finalize();
    };

    const ctx: StreamResultContext<T> = { settle, resolve, reject };
    const handlers = build(ctx);
    const timer = setTimeout(() => onTimeout(ctx), timeoutMs);

    try {
      connection = client.transport.connectSession({
        sessionId: connect.sessionId,
        identity: client.identity,
        ...(connect.afterSeq !== undefined ? { afterSeq: connect.afterSeq } : {}),
        onEvent: handlers.onEvent,
        ...(handlers.onReplayComplete ? { onReplayComplete: handlers.onReplayComplete } : {}),
        ...(handlers.onStatus ? { onStatus: handlers.onStatus } : {}),
      });
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
