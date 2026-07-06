import { asRecord } from "@host/boot/decode";

/**
 * Responsible for: the protocol-NEUTRAL JSON-RPC toolkit both `mcp/` and `lsp/` build on - the request/
 * notification/response envelope builders, the tolerant error/timeout decoders (generic over each
 * protocol's own error classes), and the server-originated-request outcome ladder. It knows JSON-RPC,
 * not MCP or LSP, so neither protocol has to reach into the other for these mechanics.
 *
 * Not for: MCP handshake/version negotiation (that stays in `mcp/transport.ts`), the byte framing
 * (`json-rpc/framing.ts`), or the correlated connection loop (`json-rpc/framed-connection.ts`).
 */

/** The JSON-RPC answer to one server-originated request: a result or a structured error. */
export type ServerRequestOutcome =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/**
 * Answers a server-originated request (MCP elicitation/create or sampling/createMessage) riding the
 * connection mid-call (plan 23 M6). A transport accepts one in its options and sends its outcome back
 * as the JSON-RPC response; without a handler it answers method-not-found. The handler must never throw
 * - the mediator (mcp/mediation.ts) owns turning failures into structured errors - but
 * {@link serverRequestOutcome} backs a rejection with an internal-error response anyway.
 */
export type ServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<ServerRequestOutcome>;

/** One JSON-RPC request envelope; `params` is omitted entirely when undefined. */
export function requestEnvelope(
  id: number,
  method: string,
  params?: unknown,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

/** One JSON-RPC notification envelope (no id, so no reply is ever expected). */
export function notificationEnvelope(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

/** The JSON-RPC response envelope answering one server-originated request. */
export function responseEnvelope(
  id: number | string,
  outcome: ServerRequestOutcome,
): Record<string, unknown> {
  return "result" in outcome
    ? { jsonrpc: "2.0", id, result: outcome.result }
    : { jsonrpc: "2.0", id, error: outcome.error };
}

/** The props a JSON-RPC-error class (McpRpcError, LspRpcError) is constructed from. */
export interface RpcErrorProps {
  readonly server: string;
  readonly method: string;
  readonly code?: number;
  readonly detail: string;
}

/**
 * Decodes a JSON-RPC `error` member into the typed per-request failure. Generic over the
 * error constructor so each protocol keeps its own vocabulary (McpRpcError, LspRpcError)
 * without re-spelling the tolerant decode.
 */
export function decodeRpcError<E>(
  server: string,
  method: string,
  raw: unknown,
  rpcError: new (props: RpcErrorProps) => E,
  fallbackDetail = "JSON-RPC error",
): E {
  const error = asRecord(raw) ?? {};
  return new rpcError({
    server,
    method,
    ...(typeof error.code === "number" ? { code: error.code } : {}),
    detail: typeof error.message === "string" ? error.message : fallbackDetail,
  });
}

/**
 * The server-originated-request outcome ladder both transports share: no handler answers
 * method-not-found (-32601); a handler crash answers a structured internal error (-32603) -
 * the mediator answers structurally, so that branch only covers a defect in it. Never throws.
 */
export async function serverRequestOutcome(
  handler: ServerRequestHandler | undefined,
  method: string,
  params: unknown,
): Promise<ServerRequestOutcome> {
  if (!handler) {
    return { error: { code: -32601, message: `method not supported: ${method}` } };
  }
  return handler(method, params).then(
    (outcome) => outcome,
    () => ({ error: { code: -32603, message: "host mediation failed internally" } }) as const,
  );
}

/** The props a request-timeout class (McpTimeoutError, LspTimeoutError) is constructed from. */
export interface TimeoutErrorProps {
  readonly server: string;
  readonly method: string;
  readonly timeoutMs: number;
}

/**
 * Arms the shared per-request deadline: after `timeoutMs` the callback receives the typed
 * timeout error, constructed through the given class so each protocol keeps its own vocabulary
 * (McpTimeoutError, LspTimeoutError). Returns the disposer; the timer never keeps the process
 * alive.
 */
export function armRequestTimeout<E>(
  server: string,
  method: string,
  timeoutMs: number,
  timeoutError: new (props: TimeoutErrorProps) => E,
  onTimeout: (error: E) => void,
): () => void {
  const timer = setTimeout(
    () => onTimeout(new timeoutError({ server, method, timeoutMs })),
    timeoutMs,
  );
  timer.unref?.();
  return () => clearTimeout(timer);
}
