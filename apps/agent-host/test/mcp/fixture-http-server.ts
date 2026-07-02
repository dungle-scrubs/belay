import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BIG_FIXTURE_CHARS,
  catalogPage,
  catalogToolsFor,
  FIXTURE_ELICITATION_PARAMS,
  FIXTURE_PROMPTS,
  FIXTURE_RESOURCE_CONTENTS,
  FIXTURE_RESOURCES,
  FIXTURE_SAMPLING_PARAMS,
  type FixtureCatalogMode,
  fixturePromptResult,
} from "./fixture-catalog";

/**
 * A minimal MCP Streamable HTTP fixture server for the http transport integration tests
 * (plan 23 M3/M4/M5). A REAL node:http server with its own inline JSON-RPC handling (deliberately
 * independent of src/mcp, so the tests are cross-implementation, not self-confirming). Clients
 * POST JSON-RPC to the endpoint; replies come back as application/json or - in
 * `responseMode: "sse"` - as a text/event-stream event, per the Streamable HTTP spec. The
 * fixture ALWAYS issues an `mcp-session-id` on initialize and rejects any follow-up without a
 * known one (404 + JSON-RPC error), so a passing follow-up proves the client echoed the id.
 * Lists (tools/resources/prompts) come paginated from the shared ./fixture-catalog;
 * resources/read serves the shared FIXTURE_RESOURCE_CONTENTS. Behavior triggers, mirroring the
 * stdio fixture's tools:
 *   echo       - returns the given text
 *   args_probe - returns JSON.stringify(arguments) (for the M5 argument round-trip test)
 *   big        - returns `chars` (default BIG_FIXTURE_CHARS) characters (for bounding tests)
 *   soft_fail  - returns an isError result with content (for the M5 isError path)
 *   boom       - responds with a JSON-RPC error
 *   hang       - never responds (for timeout tests)
 *   garbage    - responds with a non-JSON body (or a non-JSON SSE data event)
 *   sever      - destroys the socket mid-response (SSE mode: after headers + a comment event)
 * M6 mediation probes (SSE mode only - a plain-JSON reply has no stream to carry a
 * server-originated request): `elicit_probe` / `sampling_probe` open the response stream,
 * emit an elicitation/create / sampling/createMessage REQUEST event, wait for the client to
 * POST the JSON-RPC response back (answered 202 per the spec), then emit the original call's
 * result carrying that response as JSON text. prompts/get expands the shared
 * ./fixture-catalog prompts with argument substitution.
 * Options: `requireBearer` (401 without/with a wrong token), `protocolVersion` (forces the
 * initialize result's version, for negotiation tests), `catalog` (a ./fixture-catalog mode).
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

interface JsonRpcIn {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: {
    readonly protocolVersion?: string;
    readonly cursor?: string;
    readonly name?: string;
    readonly uri?: string;
    readonly arguments?: Record<string, unknown>;
  };
  readonly result?: unknown;
  readonly error?: unknown;
}

export async function startFixtureHttpServer(
  options: FixtureHttpServerOptions = {},
): Promise<FixtureHttpServer> {
  const responseMode = options.responseMode ?? "json";
  const catalogMode = options.catalog ?? "default";
  const issued: string[] = [];
  const sessions = new Set<string>();
  const recorded: RecordedFixtureRequest[] = [];
  let toolsListCalls = 0;
  /** Server-originated requests awaiting the client's POSTed response, keyed by request id. */
  const pendingServerRequests = new Map<string, (response: JsonRpcIn) => void>();
  let serverRequestSeq = 0;

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

  const handleToolCall = (response: ServerResponse, message: JsonRpcIn): void => {
    const name = message.params?.name;
    if (name === "echo") {
      replyResult(response, message.id, {
        content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }],
      });
      return;
    }
    if (name === "args_probe") {
      replyResult(response, message.id, {
        content: [{ type: "text", text: JSON.stringify(message.params?.arguments ?? {}) }],
      });
      return;
    }
    if (name === "big") {
      const chars = Number(message.params?.arguments?.chars ?? BIG_FIXTURE_CHARS);
      replyResult(response, message.id, { content: [{ type: "text", text: "b".repeat(chars) }] });
      return;
    }
    if (name === "soft_fail") {
      replyResult(response, message.id, {
        content: [{ type: "text", text: "external service exploded" }],
        isError: true,
      });
      return;
    }
    if (name === "elicit_probe" || name === "sampling_probe") {
      if (responseMode !== "sse") {
        replyRpcError(
          response,
          message.id,
          -32603,
          `${name} needs the sse response mode (a plain-JSON reply has no stream for a server-originated request)`,
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": fixture stream open\n\n");
      serverRequestSeq += 1;
      const requestId = `srv-${serverRequestSeq}`;
      pendingServerRequests.set(requestId, (clientResponse) => {
        const observed = JSON.stringify({
          ...(clientResponse.result !== undefined ? { result: clientResponse.result } : {}),
          ...(clientResponse.error !== undefined ? { error: clientResponse.error } : {}),
        });
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: observed }] },
        });
        response.write(`event: message\ndata: ${body}\n\n`);
        response.end();
      });
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: name === "elicit_probe" ? "elicitation/create" : "sampling/createMessage",
        params: name === "elicit_probe" ? FIXTURE_ELICITATION_PARAMS : FIXTURE_SAMPLING_PARAMS,
      });
      response.write(`event: message\ndata: ${request}\n\n`);
      return;
    }
    if (name === "boom") {
      replyRpcError(response, message.id, -32001, "boom tool always fails");
      return;
    }
    if (name === "hang") {
      return; // deliberately never responds; close() reaps the socket
    }
    if (name === "garbage") {
      replyGarbage(response);
      return;
    }
    if (name === "sever") {
      sever(response);
      return;
    }
    replyRpcError(response, message.id, -32601, `unknown tool ${String(name)}`);
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
      replyResult(
        response,
        message.id,
        {
          protocolVersion:
            options.protocolVersion ?? message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "trevor-mcp-http-fixture", version: "0.0.1" },
        },
        { "mcp-session-id": sessionId },
      );
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
      const pending =
        message.id === undefined ? undefined : pendingServerRequests.get(String(message.id));
      response.writeHead(pending ? 202 : 400);
      response.end();
      if (pending) {
        pendingServerRequests.delete(String(message.id));
        pending(message);
      }
      return;
    }
    if (message.method.startsWith("notifications/")) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === "tools/list") {
      if (message.params?.cursor === undefined) {
        toolsListCalls += 1;
      }
      const { page, nextCursor } = catalogPage(
        catalogToolsFor(catalogMode, toolsListCalls),
        message.params?.cursor,
      );
      replyResult(response, message.id, { tools: page, ...(nextCursor ? { nextCursor } : {}) });
      return;
    }
    if (message.method === "resources/list") {
      const { page, nextCursor } = catalogPage(FIXTURE_RESOURCES, message.params?.cursor);
      replyResult(response, message.id, {
        resources: page,
        ...(nextCursor ? { nextCursor } : {}),
      });
      return;
    }
    if (message.method === "prompts/list") {
      const { page, nextCursor } = catalogPage(FIXTURE_PROMPTS, message.params?.cursor);
      replyResult(response, message.id, { prompts: page, ...(nextCursor ? { nextCursor } : {}) });
      return;
    }
    if (message.method === "prompts/get") {
      const expanded = fixturePromptResult(message.params?.name, message.params?.arguments);
      if (!expanded) {
        replyRpcError(
          response,
          message.id,
          -32602,
          `unknown prompt ${String(message.params?.name)}`,
        );
        return;
      }
      replyResult(response, message.id, expanded);
      return;
    }
    if (message.method === "resources/read") {
      const uri = message.params?.uri;
      const contents = uri === undefined ? undefined : FIXTURE_RESOURCE_CONTENTS[uri];
      if (!contents) {
        replyRpcError(response, message.id, -32002, `resource not found: ${String(uri)}`);
        return;
      }
      replyResult(response, message.id, {
        contents: [
          {
            uri,
            mimeType: contents.mimeType,
            ...(contents.text !== undefined ? { text: contents.text } : { blob: contents.blob }),
          },
        ],
      });
      return;
    }
    if (message.method === "tools/call") {
      handleToolCall(response, message);
      return;
    }
    replyRpcError(response, message.id, -32601, `method not found: ${String(message.method)}`);
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
