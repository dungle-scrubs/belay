import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FixtureCatalogMode } from "./fixture-catalog";
import {
  createFixtureDispatcher,
  createFixtureServerRequests,
  type JsonRpcIn,
  observedResponseText,
  probeRequest,
} from "./fixture-dispatch";

/**
 * A minimal MCP Streamable HTTP fixture server for the http transport integration tests
 * (plan 23 M3/M4/M5). A REAL node:http server, deliberately independent of src/mcp, so the
 * tests are cross-implementation, not self-confirming. Clients POST JSON-RPC to the endpoint;
 * replies come back as application/json or - in `responseMode: "sse"` - as a text/event-stream
 * event, per the Streamable HTTP spec. The fixture ALWAYS issues an `mcp-session-id` on
 * initialize and rejects any follow-up without a known one (404 + JSON-RPC error), so a
 * passing follow-up proves the client echoed the id. Method dispatch - initialize, the
 * paginated ./fixture-catalog lists, prompts/get, resources/read, and the common tools/call
 * behaviors (echo, args_probe, big, soft_fail, boom, hang) - is the shared ./fixture-dispatch;
 * only the wire mechanics and http-specific triggers live here:
 *   garbage - responds with a non-JSON body (or a non-JSON SSE data event)
 *   sever   - destroys the socket mid-response (SSE mode: after headers + a comment event)
 * M6 mediation probes (SSE mode only - a plain-JSON reply has no stream to carry a
 * server-originated request): `elicit_probe` / `sampling_probe` open the response stream,
 * emit the ./fixture-dispatch probe REQUEST event, wait for the client to POST the JSON-RPC
 * response back (answered 202 per the spec), then emit the original call's result carrying
 * that response as JSON text.
 * Options: `requireBearer` (401 without/with a wrong token), `protocolVersion` (forces the
 * initialize result's version), `catalog` (a ./fixture-catalog mode), `notificationStatus`
 * (the HTTP status notifications get, default 202 - a non-2xx exercises the transport's
 * notification-failure recording).
 */

export interface FixtureHttpServerOptions {
  /** How replies ride back to a POST: plain JSON (default) or a text/event-stream event. */
  readonly responseMode?: "json" | "sse";
  /** When set, every request must present exactly `Bearer <token>` or gets a 401. */
  readonly requireBearer?: string;
  /** Forces the initialize result's protocolVersion (for negotiation-failure tests). */
  readonly protocolVersion?: string;
  /** Which shared catalog the list methods serve (default: the two M2 tools). */
  readonly catalog?: FixtureCatalogMode;
  /** The HTTP status notifications are answered with (default 202 per the spec). */
  readonly notificationStatus?: number;
}

/** One observed JSON-RPC request, for session-preservation assertions. */
export interface RecordedFixtureRequest {
  readonly method: string;
  readonly sessionId?: string;
}

export interface FixtureHttpServer {
  readonly endpoint: string;
  /** Every session id the fixture has issued, in order. */
  readonly sessionIds: () => readonly string[];
  /** Every JSON-RPC request body the fixture accepted, with its session header. */
  readonly requests: () => readonly RecordedFixtureRequest[];
  readonly close: () => Promise<void>;
}

export async function startFixtureHttpServer(
  options: FixtureHttpServerOptions = {},
): Promise<FixtureHttpServer> {
  const responseMode = options.responseMode ?? "json";
  const issued: string[] = [];
  const sessions = new Set<string>();
  const recorded: RecordedFixtureRequest[] = [];
  const dispatcher = createFixtureDispatcher({
    serverInfoName: "trevor-mcp-http-fixture",
    protocolVersion: options.protocolVersion,
    catalog: options.catalog ?? "default",
  });
  const serverRequests = createFixtureServerRequests();

  const reply = (
    response: ServerResponse,
    message: unknown,
    status: number,
    extraHeaders: Record<string, string> = {},
  ): void => {
    const body = JSON.stringify(message);
    if (responseMode === "sse") {
      response.writeHead(status, { "content-type": "text/event-stream", ...extraHeaders });
      response.write(": fixture stream open\n\n");
      response.write(`event: message\ndata: ${body}\n\n`);
      response.end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json", ...extraHeaders });
    response.end(body);
  };

  const replyResult = (
    response: ServerResponse,
    id: JsonRpcIn["id"],
    value: unknown,
    extraHeaders: Record<string, string> = {},
  ): void => {
    reply(response, { jsonrpc: "2.0", id, result: value }, 200, extraHeaders);
  };

  const replyRpcError = (
    response: ServerResponse,
    id: JsonRpcIn["id"],
    code: number,
    message: string,
  ): void => {
    reply(response, { jsonrpc: "2.0", id, error: { code, message } }, 200);
  };

  const replyGarbage = (response: ServerResponse): void => {
    if (responseMode === "sse") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: message\ndata: this is not json {\n\n");
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("this is not json {");
  };

  const sever = (response: ServerResponse): void => {
    if (responseMode === "sse") {
      // Open a believable stream, then kill it before the response event ever arrives.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": fixture stream open\n\n");
    }
    response.socket?.destroy();
  };

  /** The http-only tools/call triggers; false hands the call to the shared dispatcher. */
  const handleWireToolCall = (response: ServerResponse, message: JsonRpcIn): boolean => {
    const name = message.params?.name;
    if (name === "garbage") {
      replyGarbage(response);
      return true;
    }
    if (name === "sever") {
      sever(response);
      return true;
    }
    if (name === "elicit_probe" || name === "sampling_probe") {
      if (responseMode !== "sse") {
        replyRpcError(
          response,
          message.id,
          -32603,
          `${name} needs the sse response mode (a plain-JSON reply has no stream for a server-originated request)`,
        );
        return true;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": fixture stream open\n\n");
      const { method, params } = probeRequest(name);
      const request = serverRequests.open(method, params, (clientResponse) => {
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: observedResponseText(clientResponse) }] },
        });
        response.write(`event: message\ndata: ${body}\n\n`);
        response.end();
      });
      response.write(`event: message\ndata: ${JSON.stringify(request)}\n\n`);
      return true;
    }
    return false;
  };

  const handle = (request: IncomingMessage, response: ServerResponse, body: string): void => {
    if (options.requireBearer !== undefined) {
      if (request.headers.authorization !== `Bearer ${options.requireBearer}`) {
        response.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": "Bearer",
        });
        response.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
    }

    const sessionHeader =
      typeof request.headers["mcp-session-id"] === "string"
        ? request.headers["mcp-session-id"]
        : undefined;

    if (request.method === "DELETE") {
      if (sessionHeader) {
        sessions.delete(sessionHeader);
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "POST only" }));
      return;
    }

    let message: JsonRpcIn;
    try {
      message = JSON.parse(body) as JsonRpcIn;
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "body is not JSON" }));
      return;
    }
    if (message.method !== undefined) {
      // JSON-RPC responses (M6 mediation) are not requests; only real methods are recorded.
      recorded.push({
        method: message.method,
        ...(sessionHeader ? { sessionId: sessionHeader } : {}),
      });
    }

    if (message.method === "initialize") {
      const sessionId = randomUUID();
      issued.push(sessionId);
      sessions.add(sessionId);
      const dispatched = dispatcher.dispatch(message);
      if (dispatched.kind === "result") {
        replyResult(response, dispatched.id, dispatched.value, { "mcp-session-id": sessionId });
      }
      return;
    }

    // Session assertion: every non-initialize request must present a known session id.
    if (!sessionHeader || !sessions.has(sessionHeader)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32001, message: "unknown or missing mcp-session-id" },
        }),
      );
      return;
    }

    if (message.method === undefined) {
      // A JSON-RPC RESPONSE POSTed back for one of our server-originated requests (M6):
      // acknowledge with 202 per the Streamable HTTP spec and complete the waiting call.
      const settled = serverRequests.settle(message);
      response.writeHead(settled ? 202 : 400);
      response.end();
      return;
    }
    if (message.method.startsWith("notifications/")) {
      response.writeHead(options.notificationStatus ?? 202);
      response.end();
      return;
    }
    if (message.method === "tools/call" && handleWireToolCall(response, message)) {
      return;
    }
    const dispatched = dispatcher.dispatch(message);
    if (dispatched.kind === "result") {
      replyResult(response, dispatched.id, dispatched.value);
    } else if (dispatched.kind === "error") {
      replyRpcError(response, dispatched.id, dispatched.code, dispatched.message);
    }
    // "none": deliberately no reply (hang); close() reaps the socket.
  };

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => handle(request, response, body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}/mcp`,
    sessionIds: () => [...issued],
    requests: () => [...recorded],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
