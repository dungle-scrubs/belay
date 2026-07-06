import { asRecord } from "@host/boot/decode";
import { McpHandshakeError, type McpTransportErrorTag } from "./errors";

/**
 * The transport-agnostic MCP client contract (plan 23 M3): the one interface every transport
 * (./stdio-transport, ./http-transport) satisfies, plus the MCP-specific protocol pieces they share -
 * version negotiation data, initialize-result decoding, and the handshake success sequence. Everything
 * above the transports (capability discovery, tool execution, /doctor snapshots) programs against
 * {@link McpTransport} only, so a server's transport choice is invisible past this seam.
 *
 * Responsible for: the shared McpTransport contract, protocol-version negotiation data, and the MCP
 * handshake. The protocol-NEUTRAL JSON-RPC mechanics (envelopes, rpc-error decode, the
 * server-request outcome ladder, deadline arming) live in `json-rpc/rpc.ts` so `lsp/` shares them
 * without depending on `mcp/`.
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
