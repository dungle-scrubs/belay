import type { HardenedChild } from "@host/processes/child-spawn";
import { msg } from "@host/transport/messages";
import { createFrameParser, encodeFrame } from "../mcp/framing";
import {
  armRequestTimeout,
  decodeRpcError,
  type McpServerRequestOutcome,
  notificationEnvelope,
  type RpcErrorProps,
  requestEnvelope,
  responseEnvelope,
} from "../mcp/transport";

/**
 * Protocol-neutral JSON-RPC over Content-Length-framed child stdio. Owns the generic mechanics:
 * request ids, pending-map timeout/correlation, frame parsing, malformed body handling, notifications,
 * and server-originated request responses. Callers keep protocol-specific error classes, handshake,
 * stderr redaction, shutdown choreography, and domain notifications.
 *
 * Responsible for: framed JSON-RPC request/notification correlation over child stdio.
 * Not for: protocol-specific handshakes, error classes, stderr policy, or process spawning.
 */

export interface FramedJsonRpcConnectionOptions<E extends Error> {
  readonly child: HardenedChild;
  readonly server: string;
  readonly defaultTimeoutMs: number;
  readonly timeoutError: new (props: {
    readonly server: string;
    readonly method: string;
    readonly timeoutMs: number;
  }) => E;
  readonly rpcError: new (props: RpcErrorProps) => E;
  readonly malformedError: (detail: string) => E;
  readonly recordError: <T extends E>(error: T) => T;
  readonly onFatal: (error: E) => void;
  readonly onNotification?: (method: string, params: unknown) => void;
  readonly onServerRequest?: (method: string, params: unknown) => Promise<McpServerRequestOutcome>;
}

interface PendingRequest<E extends Error> {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: E) => void;
  readonly cancelTimeout: () => void;
}

export interface FramedJsonRpcConnection<E extends Error> {
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  readonly notify: (method: string, params?: unknown) => void;
  readonly send: (message: Record<string, unknown>) => void;
  readonly terminate: (error: E) => void;
  readonly closed: () => boolean;
}

export function createFramedJsonRpcConnection<E extends Error>(
  options: FramedJsonRpcConnectionOptions<E>,
): FramedJsonRpcConnection<E> {
  let fate: E | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingRequest<E>>();
  const parser = createFrameParser();

  const settle = (id: number): PendingRequest<E> | undefined => {
    const entry = pending.get(id);
    if (entry) {
      entry.cancelTimeout();
      pending.delete(id);
    }
    return entry;
  };

  const terminate = (error: E): void => {
    if (fate) {
      return;
    }
    fate = error;
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(error);
    }
    options.onFatal(error);
  };

  const send = (message: Record<string, unknown>): void => {
    try {
      options.child.stdin.write(encodeFrame(JSON.stringify(message)));
    } catch {
      // Exit/error handlers in the owner classify the broken pipe.
    }
  };

  const handleServerRequest = (message: Record<string, unknown>): void => {
    const id = message.id as number | string;
    const method = String(message.method);
    const handler = options.onServerRequest;
    const outcome = handler
      ? handler(method, message.params).catch(
          () => ({ error: { code: -32603, message: "host mediation failed internally" } }) as const,
        )
      : Promise.resolve({
          error: { code: -32601, message: `method not supported: ${method}` },
        } as const);

    void outcome.then((result) => {
      if (!fate) {
        send(responseEnvelope(id, result));
      }
    });
  };

  const handleBody = (body: string): void => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      message = parsed as Record<string, unknown>;
    } catch {
      terminate(
        options.recordError(
          options.malformedError(`response body is not a JSON object: ${body.slice(0, 120)}`),
        ),
      );
      return;
    }

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const entry = settle(message.id);
      if (!entry) {
        return;
      }
      if ("error" in message) {
        entry.reject(
          options.recordError(
            decodeRpcError(options.server, entry.method, message.error, options.rpcError),
          ),
        );
        return;
      }
      entry.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      if (message.id === undefined) {
        options.onNotification?.(message.method, message.params);
      } else if (!fate) {
        handleServerRequest(message);
      }
      return;
    }

    const entryId = typeof message.id === "number" ? message.id : undefined;
    const malformed = options.recordError(
      options.malformedError("response carries neither result nor error"),
    );
    if (entryId !== undefined) {
      settle(entryId)?.reject(malformed);
    }
  };

  options.child.stdout.on("data", (chunk: Buffer) => {
    let frames: string[];
    try {
      frames = parser.push(chunk);
    } catch (error) {
      terminate(options.recordError(options.malformedError(msg(error))));
      return;
    }
    for (const body of frames) {
      handleBody(body);
    }
  });

  return {
    request: (method, params, timeoutMs = options.defaultTimeoutMs) =>
      new Promise((resolve, reject) => {
        if (fate) {
          reject(fate);
          return;
        }
        const id = nextId;
        nextId += 1;
        const cancelTimeout = armRequestTimeout(
          options.server,
          method,
          timeoutMs,
          options.timeoutError,
          (timeout) => {
            const entry = settle(id);
            if (entry) {
              entry.reject(options.recordError(timeout));
            }
          },
        );
        pending.set(id, { method, resolve, reject, cancelTimeout });
        send(requestEnvelope(id, method, params));
      }),
    notify: (method, params) => {
      if (!fate) {
        send(notificationEnvelope(method, params));
      }
    },
    send,
    terminate,
    closed: () => fate !== null,
  };
}
