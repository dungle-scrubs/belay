import { Data } from "effect";

/**
 * Typed LSP client failures as Data.TaggedError (plan 24 M2), following the host's error
 * convention (mcp/errors.ts, tools/errors.ts): a failure is CLASSIFIED - callers discriminate
 * by `_tag`, never by parsing a message. These stay INSIDE the lsp/ subsystem: the manager
 * maps every one of them to a plain degraded result variant (./contract, D-006), so nothing
 * LSP ever throws through a turn.
 *
 * Responsible for: the typed LSP failure vocabulary - handshake, timeout, crash, closed,
 * JSON-RPC, malformed-response - and the LspClientError union.
 * Not for: the degraded RESULT variants the tools render - ./contract owns those.
 */

/** The initialize handshake failed (a malformed initialize result). Terminal. */
export class LspHandshakeError extends Data.TaggedError("LspHandshakeError")<{
  readonly server: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `LSP handshake with "${this.server}" failed: ${this.detail}`;
  }
}

/** A request passed its deadline. Per-request: the client itself stays up (except during the
 *  handshake, where the caller treats it as terminal). */
export class LspTimeoutError extends Data.TaggedError("LspTimeoutError")<{
  readonly server: string;
  readonly method: string;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `LSP request "${this.method}" to "${this.server}" timed out after ${this.timeoutMs}ms`;
  }
}

/** The server process died: spawn failure, crash, or an exit before responding. Terminal. */
export class LspServerCrashError extends Data.TaggedError("LspServerCrashError")<{
  readonly server: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `LSP server "${this.server}" crashed: ${this.detail}`;
  }
}

/** The connection was closed on our side; pending and later requests get this. Terminal. */
export class LspClosedError extends Data.TaggedError("LspClosedError")<{
  readonly server: string;
  readonly detail?: string;
}> {
  override get message(): string {
    return `LSP connection to "${this.server}" is closed${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** The server answered a request with a JSON-RPC error object. Per-request, not terminal. */
export class LspRpcError extends Data.TaggedError("LspRpcError")<{
  readonly server: string;
  readonly method: string;
  readonly code?: number;
  readonly detail: string;
}> {
  override get message(): string {
    return `LSP server "${this.server}" returned a JSON-RPC error for "${this.method}": ${this.detail}`;
  }
}

/** The server sent bytes we framed but could not interpret (non-JSON body, or a response that
 *  is neither result nor error). A broken stream loses correlation, so this is terminal when
 *  it poisons the whole pipe. */
export class LspMalformedResponseError extends Data.TaggedError("LspMalformedResponseError")<{
  readonly server: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `LSP server "${this.server}" sent a malformed response: ${this.detail}`;
  }
}

export type LspClientError =
  | LspHandshakeError
  | LspTimeoutError
  | LspServerCrashError
  | LspClosedError
  | LspRpcError
  | LspMalformedResponseError;

/** The machine-readable failure classification the client's state snapshot carries. */
export type LspClientErrorTag = LspClientError["_tag"];

const CLIENT_ERROR_TAGS: ReadonlySet<string> = new Set([
  "LspHandshakeError",
  "LspTimeoutError",
  "LspServerCrashError",
  "LspClosedError",
  "LspRpcError",
  "LspMalformedResponseError",
]);

/** Narrows an unknown rejection to the typed LSP vocabulary (for degrade-mapping paths). */
export function isLspClientError(error: unknown): error is LspClientError {
  return error instanceof Error && "_tag" in error && CLIENT_ERROR_TAGS.has(String(error._tag));
}
