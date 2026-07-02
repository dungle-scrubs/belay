import { McpHandshakeError, McpTimeoutError } from "./errors";

/**
 * The transport-agnostic MCP client contract (plan 23 M3): the one interface every transport
 * (./stdio-transport, ./http-transport) satisfies, plus the protocol pieces they share -
 * version negotiation data, initialize-result decoding, and per-request deadline arming.
 * Everything above the transports (capability discovery, tool execution, /doctor snapshots)
 * programs against {@link McpTransport} only, so a server's transport choice is invisible
 * past this seam.
 *
 * Responsible for: the shared McpTransport contract, protocol-version negotiation data, and
 * the initialize-decoding + request-deadline helpers every transport shares.
 * Not for: wire mechanics - child pipes live in ./stdio-transport, HTTP/SSE in
 * ./http-transport.
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

/**
 * Decodes a raw initialize result into the negotiated {@link McpInitializeResult}, in the
 * outcome-union style of ./config's normalizeServer: an unsupported or missing
 * protocolVersion is a structured handshake failure, never a throw from here.
 */
export function decodeInitializeResult(
  server: string,
  raw: unknown,
): { result: McpInitializeResult } | { failure: McpHandshakeError } {
  const record =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
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
