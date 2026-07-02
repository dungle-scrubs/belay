import { asRecord } from "@host/boot/decode";
import { type McpHttpServerConfig, redactMcpEndpoint } from "./config";
import {
  isMcpTransportError,
  McpAuthRequiredError,
  McpClosedError,
  McpMalformedResponseError,
  McpRpcError,
  McpTimeoutError,
  type McpTransportError,
  type McpTransportErrorTag,
} from "./errors";
import { MAX_FRAME_BODY_BYTES } from "./framing";
import { createSseParser } from "./sse";
import {
  armRequestTimeout,
  decodeRpcError,
  type McpInitializeResult,
  type McpServerRequestHandler,
  type McpTransport,
  type McpTransportState,
  notificationEnvelope,
  performHandshake,
  requestEnvelope,
  responseEnvelope,
  serverRequestOutcome,
} from "./transport";

/**
 * The MCP Streamable HTTP transport (plan 23 M3): POSTs JSON-RPC to a configured endpoint and
 * accepts BOTH reply shapes the spec allows - a plain application/json body, or a
 * text/event-stream whose SSE events carry the JSON-RPC messages (./sse decodes the events).
 * The server-issued `mcp-session-id` response header is captured and echoed on every
 * subsequent request (and best-effort DELETEd on close), bearer auth comes from config and
 * never survives into an error or state string (endpoints are redacted via ./config), every
 * request gets the shared per-request deadline, and every reply body - JSON or SSE
 * accumulation - is capped at the same 32MiB bound the stdio framing enforces. Failures are
 * classified through ./errors: 401/403 parks the transport in "auth_needed", a handshake
 * failure in "failed"; other request failures (timeout, rpc error, malformed reply, severed
 * stream) stay per-request because each POST is its own exchange.
 *
 * Responsible for: the Streamable HTTP/SSE exchange lifecycle - session identity, bearer
 * auth, bounded reply parsing, and classified failures.
 * Not for: SSE line mechanics (./sse) or the shared contract/protocol helpers (./transport).
 */

export interface HttpTransportOptions {
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** Answers server-originated requests riding a response stream (M6 mediation); absent
   *  means method-not-found. The answer is POSTed back per the Streamable HTTP spec. */
  readonly onServerRequest?: McpServerRequestHandler;
  /** Reply-size cap in bytes (default the shared 32MiB frame bound); injectable for tests. */
  readonly maxResponseBytes?: number;
}

/** The pure request-header assembly: JSON body, dual accept, optional bearer/session/version. */
export function buildHttpHeaders(
  server: McpHttpServerConfig,
  context: { readonly sessionId?: string; readonly protocolVersion?: string } = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(server.auth?.bearerToken ? { authorization: `Bearer ${server.auth.bearerToken}` } : {}),
    ...(context.sessionId ? { "mcp-session-id": context.sessionId } : {}),
    ...(context.protocolVersion ? { "mcp-protocol-version": context.protocolVersion } : {}),
  };
}

/** Builds the transport over the server's endpoint; no connection is opened until first use. */
export function createHttpTransport(
  server: McpHttpServerConfig,
  options: HttpTransportOptions = {},
): McpTransport {
  const clientInfo = options.clientInfo ?? { name: "trevor", version: "dev" };
  const redacted = redactMcpEndpoint(server.endpoint);
  const maxResponseBytes = options.maxResponseBytes ?? MAX_FRAME_BODY_BYTES;

  let status: McpTransportState["status"] = "configured";
  let initialized = false;
  let protocolVersion: string | undefined;
  let sessionId: string | undefined;
  let lastError: string | undefined;
  let lastErrorTag: McpTransportErrorTag | undefined;
  /** The terminal failure every later request gets; null while usable. */
  let fate: McpTransportError | null = null;
  let nextId = 1;
  let initPromise: Promise<McpInitializeResult> | null = null;
  let closePromise: Promise<void> | null = null;
  const inflight = new Set<AbortController>();

  const fail = <E extends McpTransportError>(error: E): E => {
    lastError = error.message;
    lastErrorTag = error._tag;
    return error;
  };

  const terminate = (
    error: McpTransportError,
    terminalStatus: McpTransportState["status"],
  ): void => {
    if (fate) {
      return;
    }
    fate = error;
    status = terminalStatus;
    fail(error);
  };

  /** Interprets one JSON-RPC message as the reply to request `id`; undefined = not ours. */
  const interpretReply = (
    message: Record<string, unknown>,
    id: number,
    method: string,
  ): { value: unknown } | undefined => {
    if (message.id !== id || !("result" in message || "error" in message)) {
      return undefined;
    }
    if ("error" in message) {
      throw fail(decodeRpcError(server.name, method, message.error, McpRpcError));
    }
    return { value: message.result };
  };

  const parseJsonObject = (text: string): Record<string, unknown> => {
    let record: Record<string, unknown> | undefined;
    try {
      record = asRecord(JSON.parse(text));
    } catch {
      record = undefined;
    }
    if (!record) {
      throw fail(
        new McpMalformedResponseError({
          server: server.name,
          detail: `response body is not a JSON object: ${text.slice(0, 120)}`,
        }),
      );
    }
    return record;
  };

  /** Reads a reply body as text, bounded: crossing the reply cap is a malformed response. */
  const readBodyText = async (response: Response): Promise<string> => {
    const body = response.body;
    if (!body) {
      return "";
    }
    const decoder = new TextDecoder();
    let text = "";
    let received = 0;
    for await (const chunk of body) {
      received += chunk.length;
      if (received > maxResponseBytes) {
        throw fail(
          new McpMalformedResponseError({
            server: server.name,
            detail: `response body from ${redacted} exceeds the ${maxResponseBytes}-byte cap`,
          }),
        );
      }
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  };

  /** A non-2xx reply: a JSON-RPC error body keeps its classification, anything else is malformed. */
  const classifyHttpFailure = (
    httpStatus: number,
    text: string,
    method: string,
  ): McpTransportError => {
    try {
      const error = asRecord(JSON.parse(text))?.error;
      if (asRecord(error)) {
        return fail(decodeRpcError(server.name, method, error, McpRpcError, `HTTP ${httpStatus}`));
      }
    } catch {
      // fall through: a non-JSON failure body is malformed
    }
    return fail(
      new McpMalformedResponseError({
        server: server.name,
        detail: `HTTP ${httpStatus} from ${redacted}`,
      }),
    );
  };

  /** Mediates one server-originated request off a response stream and POSTs the JSON-RPC
   *  response back to the endpoint, per the Streamable HTTP spec (M6). Never throws. */
  const answerServerRequest = async (
    method: string,
    params: unknown,
    id: number | string,
  ): Promise<void> => {
    const outcome = await serverRequestOutcome(options.onServerRequest, method, params);
    // A JSON-RPC response has no reply of its own (the server answers 202 Accepted), so it
    // rides the notification-shaped exchange; delivery failures update lastError there.
    await exchange(`${method} (response)`, responseEnvelope(id, outcome), undefined).catch(
      () => {},
    );
  };

  /** Reads an SSE reply stream until the message correlated to `id` arrives. */
  const readSseReply = async (
    body: NonNullable<Response["body"]>,
    id: number,
    method: string,
  ): Promise<unknown> => {
    const decoder = new TextDecoder();
    const parser = createSseParser();
    let received = 0;
    for await (const chunk of body) {
      received += chunk.length;
      if (received > maxResponseBytes) {
        throw fail(
          new McpMalformedResponseError({
            server: server.name,
            detail: `event stream from ${redacted} exceeds the ${maxResponseBytes}-byte reply cap`,
          }),
        );
      }
      for (const data of parser.push(decoder.decode(chunk, { stream: true }))) {
        const message = parseJsonObject(data);
        const reply = interpretReply(message, id, method);
        if (reply) {
          return reply.value; // breaking out of for-await cancels the rest of the stream
        }
        // Not our reply: a server-originated REQUEST mid-stream is mediated and answered
        // (the stream then continues toward our reply); notifications are ignored.
        if (typeof message.method === "string" && message.id !== undefined) {
          await answerServerRequest(message.method, message.params, message.id as number | string);
        }
      }
    }
    throw fail(
      new McpClosedError({
        server: server.name,
        detail: "event stream closed before the response arrived",
      }),
    );
  };

  const describeUnknown = (error: unknown): string => {
    if (error instanceof Error) {
      const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
      return `${error.message}${cause}`;
    }
    return String(error);
  };

  /**
   * One POST exchange. `id === undefined` means notification: delivered, reply discarded
   * (but a non-2xx delivery failure is still classified and recorded as lastError).
   * Every failure leaves here as a typed ./errors class.
   */
  const exchange = async (
    method: string,
    payload: Record<string, unknown>,
    id: number | undefined,
  ): Promise<unknown> => {
    if (fate) {
      throw fate;
    }
    const controller = new AbortController();
    inflight.add(controller);
    let timedOut = false;
    const disarm = armRequestTimeout(
      server.name,
      method,
      server.requestTimeoutMs,
      McpTimeoutError,
      () => {
        timedOut = true;
        controller.abort();
      },
    );
    try {
      const response = await fetch(server.endpoint, {
        method: "POST",
        headers: buildHttpHeaders(server, { sessionId, protocolVersion }),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const issuedSession = response.headers.get("mcp-session-id");
      if (issuedSession) {
        sessionId = issuedSession;
      }
      if (response.status === 401 || response.status === 403) {
        const failure = new McpAuthRequiredError({
          server: server.name,
          detail: `HTTP ${response.status} from ${redacted}`,
        });
        terminate(failure, "auth_needed");
        await response.body?.cancel().catch(() => {});
        throw failure;
      }
      if (!response.ok) {
        throw classifyHttpFailure(response.status, await readBodyText(response), method);
      }
      if (id === undefined) {
        await response.body?.cancel().catch(() => {});
        return undefined;
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/event-stream")) {
        if (!response.body) {
          throw fail(
            new McpMalformedResponseError({
              server: server.name,
              detail: "event-stream response carries no body",
            }),
          );
        }
        return await readSseReply(response.body, id, method);
      }
      if (!contentType.includes("application/json")) {
        throw fail(
          new McpMalformedResponseError({
            server: server.name,
            detail: `unexpected content-type "${contentType}" from ${redacted}`,
          }),
        );
      }
      const reply = interpretReply(parseJsonObject(await readBodyText(response)), id, method);
      if (!reply) {
        throw fail(
          new McpMalformedResponseError({
            server: server.name,
            detail: "response does not correlate to the request id",
          }),
        );
      }
      return reply.value;
    } catch (error) {
      if (timedOut) {
        throw fail(
          new McpTimeoutError({ server: server.name, method, timeoutMs: server.requestTimeoutMs }),
        );
      }
      if (isMcpTransportError(error)) {
        throw error;
      }
      // fetch/network/stream errors: connection refused, reset, severed mid-body, aborts.
      throw fail(new McpClosedError({ server: server.name, detail: describeUnknown(error) }));
    } finally {
      disarm();
      inflight.delete(controller);
    }
  };

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    return exchange(method, requestEnvelope(id, method, params), id);
  };

  const notify = (method: string, params?: unknown): void => {
    if (fate) {
      return;
    }
    void exchange(method, notificationEnvelope(method, params), undefined).catch(() => {
      // fire-and-forget: delivery failures already updated lastError via the exchange path
    });
  };

  const doInitialize = async (): Promise<McpInitializeResult> => {
    try {
      const result = await performHandshake(server.name, clientInfo, request, notify);
      initialized = true;
      protocolVersion = result.protocolVersion;
      status = "ready";
      return result;
    } catch (error) {
      // Any handshake failure is terminal for the transport; auth keeps its own status.
      if (isMcpTransportError(error)) {
        terminate(error, error._tag === "McpAuthRequiredError" ? "auth_needed" : "failed");
      }
      throw error;
    }
  };

  const doClose = async (): Promise<void> => {
    terminate(new McpClosedError({ server: server.name }), "closed");
    for (const controller of [...inflight]) {
      controller.abort();
    }
    if (sessionId) {
      // Best-effort session termination per the spec; never blocks or fails close().
      void fetch(server.endpoint, {
        method: "DELETE",
        headers: buildHttpHeaders(server, { sessionId, protocolVersion }),
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
  };

  return {
    initialize: () => {
      initPromise ??= doInitialize();
      return initPromise;
    },
    request,
    notify,
    close: () => {
      closePromise ??= doClose();
      return closePromise;
    },
    state: () => ({
      status,
      initialized,
      ...(protocolVersion ? { protocolVersion } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(lastError ? { lastError } : {}),
      ...(lastErrorTag ? { lastErrorTag } : {}),
    }),
  };
}
