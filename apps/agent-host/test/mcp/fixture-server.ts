import {
  BIG_FIXTURE_CHARS,
  catalogPage,
  catalogToolsFor,
  FIXTURE_PROMPTS,
  FIXTURE_RESOURCE_CONTENTS,
  FIXTURE_RESOURCES,
  type FixtureCatalogMode,
} from "./fixture-catalog";

/**
 * A minimal MCP stdio fixture server for the transport integration tests (plan 23 M2/M4/M5).
 * Speaks JSON-RPC 2.0 over LSP-style Content-Length frames with its OWN tiny framing
 * implementation (deliberately independent of src/mcp/framing.ts, so the tests are
 * cross-implementation, not self-confirming). Implements initialize + paginated
 * tools/resources/prompts lists (the shared ./fixture-catalog) + resources/read over the
 * shared FIXTURE_RESOURCE_CONTENTS + trivial tools, plus error triggers:
 *   echo       - returns the given text
 *   env_probe  - returns JSON.stringify(process.env) (for the D-004 env-allowlist probe)
 *   args_probe - returns JSON.stringify(arguments) (for the M5 argument round-trip test)
 *   big        - returns `chars` (default BIG_FIXTURE_CHARS) characters (for bounding tests)
 *   soft_fail  - returns an isError result with content (for the M5 isError path)
 *   boom       - responds with a JSON-RPC error
 *   hang       - never responds (for timeout tests)
 *   crash      - exits the process without responding
 *   garbage    - responds with a well-framed but non-JSON body
 * `--protocol=<v>` forces the initialize result's protocolVersion (for negotiation tests);
 * by default it echoes the client's requested version. `--catalog=large|counting` selects a
 * ./fixture-catalog mode (discovery/search-cap tests). Exits 0 when stdin ends.
 */

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
}

const protocolOverride = process.argv
  .find((arg) => arg.startsWith("--protocol="))
  ?.slice("--protocol=".length);

const catalogMode = (process.argv
  .find((arg) => arg.startsWith("--catalog="))
  ?.slice("--catalog=".length) ?? "default") as FixtureCatalogMode;

let toolsListCalls = 0;

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainFrames();
});
process.stdin.on("end", () => process.exit(0));

function drainFrames(): void {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match?.[1]) {
      process.exit(2);
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) {
      return;
    }
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body) as JsonRpcIn);
  }
}

function sendRaw(body: string): void {
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function send(message: unknown): void {
  sendRaw(JSON.stringify(message));
}

function result(id: JsonRpcIn["id"], value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id: JsonRpcIn["id"], code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message: JsonRpcIn): void {
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: protocolOverride ?? message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "trevor-mcp-fixture", version: "0.0.1" },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    return; // notification: no response
  }
  if (message.method === "tools/list") {
    if (message.params?.cursor === undefined) {
      toolsListCalls += 1;
    }
    const { page, nextCursor } = catalogPage(
      catalogToolsFor(catalogMode, toolsListCalls),
      message.params?.cursor,
    );
    result(message.id, { tools: page, ...(nextCursor ? { nextCursor } : {}) });
    return;
  }
  if (message.method === "resources/list") {
    const { page, nextCursor } = catalogPage(FIXTURE_RESOURCES, message.params?.cursor);
    result(message.id, { resources: page, ...(nextCursor ? { nextCursor } : {}) });
    return;
  }
  if (message.method === "prompts/list") {
    const { page, nextCursor } = catalogPage(FIXTURE_PROMPTS, message.params?.cursor);
    result(message.id, { prompts: page, ...(nextCursor ? { nextCursor } : {}) });
    return;
  }
  if (message.method === "resources/read") {
    const uri = message.params?.uri;
    const contents = uri === undefined ? undefined : FIXTURE_RESOURCE_CONTENTS[uri];
    if (!contents) {
      rpcError(message.id, -32002, `resource not found: ${String(uri)}`);
      return;
    }
    result(message.id, {
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
    const name = message.params?.name;
    if (name === "echo") {
      result(message.id, {
        content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }],
      });
      return;
    }
    if (name === "env_probe") {
      result(message.id, { content: [{ type: "text", text: JSON.stringify(process.env) }] });
      return;
    }
    if (name === "args_probe") {
      result(message.id, {
        content: [{ type: "text", text: JSON.stringify(message.params?.arguments ?? {}) }],
      });
      return;
    }
    if (name === "big") {
      const chars = Number(message.params?.arguments?.chars ?? BIG_FIXTURE_CHARS);
      result(message.id, { content: [{ type: "text", text: "b".repeat(chars) }] });
      return;
    }
    if (name === "soft_fail") {
      result(message.id, {
        content: [{ type: "text", text: "external service exploded" }],
        isError: true,
      });
      return;
    }
    if (name === "boom") {
      rpcError(message.id, -32001, "boom tool always fails");
      return;
    }
    if (name === "hang") {
      return; // deliberately never responds
    }
    if (name === "crash") {
      process.exit(7);
    }
    if (name === "garbage") {
      sendRaw("this is not json {");
      return;
    }
    rpcError(message.id, -32601, `unknown tool ${String(name)}`);
    return;
  }
  if (message.id !== undefined) {
    rpcError(message.id, -32601, `method not found: ${String(message.method)}`);
  }
}
