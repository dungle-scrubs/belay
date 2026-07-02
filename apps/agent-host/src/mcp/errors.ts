import { Data } from "effect";

/**
 * Typed MCP transport failures as Data.TaggedError (plan 23 M2), following the host's error
 * convention (providers/errors.ts, tools/errors.ts): a transport failure is CLASSIFIED - a
 * caller discriminates by `_tag`, never by parsing a message string. The transports themselves
 * are plain async at the I/O edge (like main.ts's transport edge), so these ride promise
 * rejections today and slot into the Effect `E` channel when the runtime layers above arrive.
 *
 * Responsible for: the typed MCP failure vocabulary - framing, handshake, timeout, crash,
 * closed, JSON-RPC, malformed-response - and the McpTransportError union.
 * Not for: config validation findings - those are McpConfigIssue DATA in ./config, not throws.
 */

/** A byte stream that does not parse as Content-Length frames (header block without a valid
 *  Content-Length, or a declared body beyond the safety cap). */
export class McpFramingError extends Data.TaggedError("McpFramingError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** The initialize handshake failed: a malformed initialize result or an unsupported
 *  protocolVersion. The transport disconnects per the MCP spec. */
export class McpHandshakeError extends Data.TaggedError("McpHandshakeError")<{
  readonly server: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `MCP handshake with "${this.server}" failed: ${this.detail}`;
  }
}

/** A request passed its per-request deadline. Per-request: the transport itself stays up. */
export class McpTimeoutError extends Data.TaggedError("McpTimeoutError")<{
  readonly server: string;
  readonly method: string;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `MCP request "${this.method}" to "${this.server}" timed out after ${this.timeoutMs}ms`;
  }
}

/** The server process died: spawn failure, crash, or an exit before responding. Terminal. */
export class McpServerCrashError extends Data.TaggedError("McpServerCrashError")<{
  readonly server: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `MCP server "${this.server}" crashed: ${this.detail}`;
  }
}

/** The connection was closed on our side; pending and later requests get this. Terminal. */
export class McpClosedError extends Data.TaggedError("McpClosedError")<{
  readonly server: string;
  readonly detail?: string;
}> {
  override get message(): string {
    return `MCP connection to "${this.server}" is closed${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** The server answered a request with a JSON-RPC error object. Per-request, not terminal. */
export class McpRpcError extends Data.TaggedError("McpRpcError")<{
  readonly server: string;
  readonly method: string;
  readonly code?: number;
  readonly detail: string;
}> {
  override get message(): string {
    return `MCP server "${this.server}" returned a JSON-RPC error for "${this.method}": ${this.detail}`;
  }
}

/** The server sent bytes we framed but could not interpret (non-JSON body, or a response
 *  that is neither result nor error). A broken stream loses correlation, so this is terminal
 *  when it poisons the whole pipe. */
export class McpMalformedResponseError extends Data.TaggedError("McpMalformedResponseError")<{
  readonly server: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `MCP server "${this.server}" sent a malformed response: ${this.detail}`;
  }
}

export type McpTransportError =
  | McpFramingError
  | McpHandshakeError
  | McpTimeoutError
  | McpServerCrashError
  | McpClosedError
  | McpRpcError
  | McpMalformedResponseError;
