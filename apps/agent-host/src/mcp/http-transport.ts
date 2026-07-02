import { type McpHttpServerConfig, redactMcpEndpoint } from "./config";
import {
  isMcpTransportError,
  McpAuthRequiredError,
  McpClosedError,
  McpMalformedResponseError,
  McpRpcError,
  McpTimeoutError,
  type McpTransportError,
} from "./errors";
import { createSseParser } from "./sse";
import {
  armRequestTimeout,
  decodeInitializeResult,
  MCP_PROTOCOL_VERSION,
  type McpInitializeResult,
  type McpServerRequestHandler,
  type McpTransport,
  type McpTransportState,
} from "./transport";

/**
 * The MCP Streamable HTTP transport (plan 23 M3): POSTs JSON-RPC to a configured endpoint and
 * accepts BOTH reply shapes the spec allows - a plain application/json body, or a
 * text/event-stream whose SSE events carry the JSON-RPC messages (./sse decodes the events).
 * The server-issued `mcp-session-id` response header is captured and echoed on every
 * subsequent request (and best-effort DELETEd on close), bearer auth comes from config and
 * never survives into an error or state string (endpoints are redacted via ./config), and
 * every request gets the shared per-request deadline. Failures are classified through
 * ./errors: 401/403 parks the transport in "auth_needed", a handshake failure in "failed";
 * other request failures (timeout, rpc error, malformed reply, severed stream) stay
 * per-request because each POST is its own exchange.
 *
 * Responsible for: the Streamable HTTP/SSE exchange lifecycle - session identity, bearer
 * auth, reply parsing, and classified failures.
 * Not for: SSE line mechanics (./sse) or the shared contract/handshake decoding (./transport).
 */

export interface HttpTransportOptions {
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** Answers server-originated requests riding a response stream (M6 mediation); absent
   *  means method-not-found. The answer is POSTed back per the Streamable HTTP spec. */
  readonly onServerRequest?: McpServerRequestHandler;
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

  let status: McpTransportState["status"] = "configured";
  let initialized = false;
  let protocolVersion: string | undefined;
  let sessionId: string | undefined;
  let lastError: string | undefined;
  /** The terminal failure every later request gets; null while usable. */
  let fate: McpTransportError | null = null;
  let nextId = 1;
  let initPromise: Promise<McpInitializeResult> | null = null;
  let closePromise: Promise<void> | null = null;
  const inflight = new Set<AbortController>();

  const fail = <E extends McpTransportError>(error: E): E => {
    lastError = error.message;
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
    lastError = error.message;
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
      const error = (message.error ?? {}) as { code?: unknown; message?: unknown };
      throw fail(
        new McpRpcError({
          server: server.name,
          method,
          ...(typeof error.code === "number" ? { code: error.code } : {}),
          detail: typeof error.message === "string" ? error.message : "JSON-RPC error",
        }),
      );
    }
    return { value: message.result };
  };

  const parseJsonObject = (text: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw fail(
        new McpMalformedResponseError({
          server: server.name,
          detail: `response body is not a JSON object: ${text.slice(0, 120)}`,
        }),
      );
    }
  };

  /** A non-2xx reply: a JSON-RPC error body keeps its classification, anything else is malformed. */
  const classifyHttpFailure = (
    httpStatus: number,
    text: string,
    method: string,
  ): McpTransportError => {
    try {
      const parsed: unknown = JSON.parse(text);
      const error =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { error?: { code?: unknown; message?: unknown } }).error
          : undefined;
      if (typeof error === "object" && error !== null) {
        return fail(
          new McpRpcError({
            server: server.name,
            method,
            ...(typeof error.code === "number" ? { code: error.code } : {}),
            detail: typeof error.message === "string" ? error.message : `HTTP ${httpStatus}`,
          }),
        );
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
    const handler = options.onServerRequest;
    const outcome = handler
      ? await handler(method, params).then(
          (value) => value,
          // The mediator answers structurally; this backstop covers a defect in it.
          () => ({ error: { code: -32603, message: "host mediation failed internally" } }) as const,
        )
      : ({ error: { code: -32601, message: `method not supported: ${method}` } } as const);
    const payload =
      "result" in outcome
        ? { jsonrpc: "2.0", id, result: outcome.result }
        : { jsonrpc: "2.0", id, error: outcome.error };
    // A JSON-RPC response has no reply of its own (the server answers 202 Accepted), so it
    // rides the notification-shaped exchange; delivery failures already updated lastError.
    await exchange(`${method} (response)`, payload, undefined).catch(() => {});
  };

  /** Reads an SSE reply stream until the message correlated to `id` arrives. */
  const readSseReply = async (
    body: NonNullable<Response["body"]>,
    id: number,
    method: string,
  ): Promise<unknown> => {
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for await (const chunk of body) {
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
   * One POST exchange. `id === undefined` means notification: delivered, reply discarded.
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
    const disarm = armRequestTimeout(server.name, method, server.requestTimeoutMs, () => {
      timedOut = true;
      controller.abort();
    });
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
      if (id === undefined) {
        await response.body?.cancel().catch(() => {});
        return undefined;
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!response.ok) {
        throw classifyHttpFailure(response.status, await response.text(), method);
      }
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
      const reply = interpretReply(parseJsonObject(await response.text()), id, method);
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
    return exchange(
      method,
      { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
      id,
    );
  };

  const notify = (method: string, params?: unknown): void => {
    if (fate) {
      return;
    }
    void exchange(
      method,
      { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
      undefined,
    ).catch(() => {
      // fire-and-forget: delivery failures already updated lastError via the exchange path
    });
  };

  const doInitialize = async (): Promise<McpInitializeResult> => {
    try {
      const raw = await request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo,
      });
      const outcome = decodeInitializeResult(server.name, raw);
      if ("failure" in outcome) {
        throw fail(outcome.failure);
      }
      notify("notifications/initialized");
      initialized = true;
      protocolVersion = outcome.result.protocolVersion;
      status = "ready";
      return outcome.result;
    } catch (error) {
      // Any handshake failure is terminal for the transport; auth keeps its own status.
      if (isMcpTransportError(error)) {
        terminate(error, error._tag === "McpAuthRequiredError" ? "auth_needed" : "failed");
        throw error;
      }
      throw error; // not reachable: exchange only rejects typed
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
    }),
  };
}
