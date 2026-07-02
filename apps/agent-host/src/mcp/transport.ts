import { asRecord } from "./decode";
import {
  McpHandshakeError,
  McpRpcError,
  McpTimeoutError,
  type McpTransportErrorTag,
} from "./errors";

/**
 * The transport-agnostic MCP client contract (plan 23 M3): the one interface every transport
 * (./stdio-transport, ./http-transport) satisfies, plus the protocol pieces they share -
 * version negotiation data, initialize-result decoding, the handshake success sequence,
 * JSON-RPC envelope builders, rpc-error decoding, the server-originated-request outcome
 * ladder, and per-request deadline arming. Everything above the transports (capability
 * discovery, tool execution, /doctor snapshots) programs against {@link McpTransport} only,
 * so a server's transport choice is invisible past this seam.
 *
 * Responsible for: the shared McpTransport contract, protocol-version negotiation data, and
 * every wire-agnostic JSON-RPC/MCP protocol helper the transports share.
 * Not for: wire mechanics - child pipes live in ./stdio-transport, HTTP/SSE in
 * ./http-transport - or transport-specific failure classification.
 */

/** The protocol version this client requests. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Server-negotiated versions the client accepts; anything else is a handshake failure. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export type McpTransportStatus = "configured" | "ready" | "auth_needed" | "failed" | "closed";

export interface McpTransportState {
  readonly status: McpTransportStatus;
  readonly initialized: boolean;
  readonly protocolVersion?: string;
  /** The server-issued `mcp-session-id`, when the transport carries one (http only). */
  readonly sessionId?: string;
  readonly lastError?: string;
  /** The machine-readable classification of lastError (the ./errors `_tag`). */
  readonly lastErrorTag?: McpTransportErrorTag;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: unknown;
  readonly serverInfo?: unknown;
}

export interface McpTransport {
  /** Runs the MCP handshake (initialize -> initialized notification); memoized. */
  readonly initialize: () => Promise<McpInitializeResult>;
  /** Sends a JSON-RPC request and resolves its correlated result. */
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  /** Sends a JSON-RPC notification (no id, no response). */
  readonly notify: (method: string, params?: unknown) => void;
  /** Drains pending requests and releases the connection. Idempotent. */
  readonly close: () => Promise<void>;
  readonly state: () => McpTransportState;
}

/** The JSON-RPC answer to one server-originated request: a result or a structured error. */
export type McpServerRequestOutcome =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/**
 * Answers a server-originated request (elicitation/create, sampling/createMessage) riding the
 * connection mid-call (plan 23 M6). Both transports accept one of these in their options and
 * send its outcome back as the JSON-RPC response; without a handler they answer
 * method-not-found, exactly as before. The handler must never throw - the mediator
 * (../mcp/mediation.ts) owns turning failures into structured errors - but
 * {@link serverRequestOutcome} backs a rejection with an internal-error response anyway.
 */
export type McpServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<McpServerRequestOutcome>;

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
  outcome: McpServerRequestOutcome,
): Record<string, unknown> {
  return "result" in outcome
    ? { jsonrpc: "2.0", id, result: outcome.result }
    : { jsonrpc: "2.0", id, error: outcome.error };
}

/** Decodes a JSON-RPC `error` member into the typed per-request failure. */
export function decodeRpcError(
  server: string,
  method: string,
  raw: unknown,
  fallbackDetail = "JSON-RPC error",
): McpRpcError {
  const error = asRecord(raw) ?? {};
  return new McpRpcError({
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
  handler: McpServerRequestHandler | undefined,
  method: string,
  params: unknown,
): Promise<McpServerRequestOutcome> {
  if (!handler) {
    return { error: { code: -32601, message: `method not supported: ${method}` } };
  }
  return handler(method, params).then(
    (outcome) => outcome,
    () => ({ error: { code: -32603, message: "host mediation failed internally" } }) as const,
  );
}

/**
 * The handshake success sequence both transports share: send initialize, decode the result,
 * and deliver the initialized notification. Throws the typed {@link McpHandshakeError} on a
 * bad negotiation and lets the transport's own request failures propagate; the CALLER owns
 * terminal-state classification (both transports treat any handshake failure as terminal).
 */
export async function performHandshake(
  server: string,
  clientInfo: { readonly name: string; readonly version: string },
  request: (method: string, params?: unknown) => Promise<unknown>,
  notify: (method: string, params?: unknown) => void,
): Promise<McpInitializeResult> {
  const raw = await request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo,
  });
  const outcome = decodeInitializeResult(server, raw);
  if ("failure" in outcome) {
    throw outcome.failure;
  }
  notify("notifications/initialized");
  return outcome.result;
}

/**
 * Decodes a raw initialize result into the negotiated {@link McpInitializeResult}, in the
 * outcome-union style of ./config's normalizeServer: an unsupported or missing
 * protocolVersion is a structured handshake failure, never a throw from here.
 */
export function decodeInitializeResult(
  server: string,
  raw: unknown,
): { result: McpInitializeResult } | { failure: McpHandshakeError } {
  const record = asRecord(raw) ?? {};
  const version = record.protocolVersion;
  if (typeof version !== "string" || !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version)) {
    return {
      failure: new McpHandshakeError({
        server,
        detail:
          typeof version === "string"
            ? `server negotiated unsupported protocolVersion "${version}"`
            : "initialize result lacks a protocolVersion",
      }),
    };
  }
  return {
    result: {
      protocolVersion: version,
      capabilities: record.capabilities,
      ...(record.serverInfo !== undefined ? { serverInfo: record.serverInfo } : {}),
    },
  };
}

/**
 * Arms the shared per-request deadline: after `timeoutMs` the callback receives the typed
 * timeout error. Returns the disposer; the timer never keeps the process alive.
 */
export function armRequestTimeout(
  server: string,
  method: string,
  timeoutMs: number,
  onTimeout: (error: McpTimeoutError) => void,
): () => void {
  const timer = setTimeout(
    () => onTimeout(new McpTimeoutError({ server, method, timeoutMs })),
    timeoutMs,
  );
  timer.unref?.();
  return () => clearTimeout(timer);
}
