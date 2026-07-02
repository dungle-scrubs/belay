import { describe, expect, it } from "vitest";
import type { McpHttpServerConfig } from "../../src/mcp/config";
import { createHttpTransport } from "../../src/mcp/http-transport";
import { MCP_PROTOCOL_VERSION, type McpTransport } from "../../src/mcp/transport";
import { httpFixtureConfig } from "./fixture-config";
import {
  type FixtureHttpServer,
  type FixtureHttpServerOptions,
  startFixtureHttpServer,
} from "./fixture-http-server";

/**
 * HTTP transport integration (plan 23 M3): drives a REAL node:http fixture speaking MCP
 * Streamable HTTP through handshake, session identity, bearer auth, tool calls, error
 * triggers, and lifecycle edges - in BOTH response modes (plain JSON and SSE event-stream),
 * which must behave identically to the caller.
 */

/** The shared http fixture config under this suite's name and tighter 5s deadline. */
function httpConfig(
  endpoint: string,
  overrides: Partial<McpHttpServerConfig> = {},
): McpHttpServerConfig {
  return httpFixtureConfig("http-fixture", endpoint, { requestTimeoutMs: 5_000, ...overrides });
}

async function withTransport(
  fixtureOptions: FixtureHttpServerOptions,
  overrides: Partial<McpHttpServerConfig>,
  run: (transport: McpTransport, fixture: FixtureHttpServer) => Promise<void>,
): Promise<void> {
  const fixture = await startFixtureHttpServer(fixtureOptions);
  const transport = createHttpTransport(httpConfig(fixture.endpoint, overrides));
  try {
    await run(transport, fixture);
  } finally {
    await transport.close();
    await fixture.close();
  }
}

function callTool(transport: McpTransport, name: string, args: Record<string, unknown> = {}) {
  return transport.request("tools/call", { name, arguments: args });
}

function textContent(response: unknown): string {
  const content = (response as { content: readonly { text: string }[] }).content;
  return content[0]?.text ?? "";
}

describe.each(["json", "sse"] as const)("http transport over %s responses", (mode) => {
  it("initializes: negotiates the protocol version and reaches ready with a session", async () => {
    await withTransport({ responseMode: mode }, {}, async (transport, fixture) => {
      const init = await transport.initialize();
      expect(init.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(init.serverInfo).toMatchObject({ name: "trevor-mcp-http-fixture" });
      expect(transport.state()).toMatchObject({
        status: "ready",
        initialized: true,
        protocolVersion: MCP_PROTOCOL_VERSION,
        sessionId: fixture.sessionIds()[0],
      });
    });
  });

  it("preserves the issued mcp-session-id on every subsequent request", async () => {
    await withTransport({ responseMode: mode }, {}, async (transport, fixture) => {
      await transport.initialize();
      await transport.request("tools/list");
      await callTool(transport, "echo", { text: "hi" });

      const sessionId = fixture.sessionIds()[0];
      expect(sessionId).toBeTruthy();
      const followUps = fixture.requests().filter((entry) => entry.method !== "initialize");
      expect(followUps.length).toBeGreaterThanOrEqual(2);
      for (const entry of followUps) {
        expect(entry.sessionId).toBe(sessionId);
      }
      // The initialized notification is fire-and-forget; wait for it to land too.
      await expect
        .poll(() =>
          fixture
            .requests()
            .some(
              (entry) =>
                entry.method === "notifications/initialized" && entry.sessionId === sessionId,
            ),
        )
        .toBe(true);
    });
  });

  it("round-trips a multibyte tool result", async () => {
    await withTransport({ responseMode: mode }, {}, async (transport) => {
      await transport.initialize();
      const response = await callTool(transport, "echo", { text: "héllo 世界 🎈" });
      expect(textContent(response)).toBe("héllo 世界 🎈");
    });
  });

  it("surfaces a JSON-RPC error as a typed rpc failure and stays usable", async () => {
    await withTransport({ responseMode: mode }, {}, async (transport) => {
      await transport.initialize();
      await expect(callTool(transport, "boom")).rejects.toMatchObject({
        _tag: "McpRpcError",
        code: -32001,
      });
      expect(transport.state().status).toBe("ready");
      const response = await callTool(transport, "echo", { text: "still here" });
      expect(textContent(response)).toBe("still here");
    });
  });

  it("classifies a non-JSON response body as malformed without killing the transport", async () => {
    await withTransport({ responseMode: mode }, {}, async (transport) => {
      await transport.initialize();
      await expect(callTool(transport, "garbage")).rejects.toMatchObject({
        _tag: "McpMalformedResponseError",
      });
      // Each POST is its own exchange; one bad reply poisons nothing.
      expect(transport.state().status).toBe("ready");
      const response = await callTool(transport, "echo", { text: "recovered" });
      expect(textContent(response)).toBe("recovered");
    });
  });

  it("times out a request the server never answers", async () => {
    await withTransport({ responseMode: mode }, { requestTimeoutMs: 300 }, async (transport) => {
      await transport.initialize();
      await expect(callTool(transport, "hang")).rejects.toMatchObject({
        _tag: "McpTimeoutError",
        timeoutMs: 300,
      });
    });
  });

  it("classifies a connection severed mid-response as closed", async () => {
    await withTransport({ responseMode: mode }, {}, async (transport) => {
      await transport.initialize();
      await expect(callTool(transport, "sever")).rejects.toMatchObject({
        _tag: "McpClosedError",
      });
    });
  });

  it("caps an oversized reply against the response-size bound as malformed", async () => {
    const fixture = await startFixtureHttpServer({ responseMode: mode });
    const transport = createHttpTransport(httpConfig(fixture.endpoint), {
      maxResponseBytes: 4_096,
    });
    try {
      await transport.initialize(); // the initialize reply is tiny - well under the cap
      await expect(callTool(transport, "big", { chars: 50_000 })).rejects.toMatchObject({
        _tag: "McpMalformedResponseError",
      });
      expect(transport.state().lastError).toContain("cap");
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
});

describe("http transport - bearer auth", () => {
  it("authenticates with the configured bearer token", async () => {
    await withTransport(
      { requireBearer: "sekret-token" },
      { auth: { bearerToken: "sekret-token" } },
      async (transport) => {
        await transport.initialize();
        expect(transport.state().status).toBe("ready");
      },
    );
  });

  it("classifies a 401 without credentials as auth-needed", async () => {
    await withTransport({ requireBearer: "sekret-token" }, {}, async (transport) => {
      await expect(transport.initialize()).rejects.toMatchObject({
        _tag: "McpAuthRequiredError",
      });
      expect(transport.state().status).toBe("auth_needed");
    });
  });

  it("never leaks the presented token into the auth failure", async () => {
    await withTransport(
      { requireBearer: "sekret-token" },
      { auth: { bearerToken: "wrong-token-value" } },
      async (transport) => {
        const failure = await transport.initialize().then(
          () => {
            throw new Error("initialize should have failed");
          },
          (error: unknown) => error as { _tag: string; message: string },
        );
        expect(failure._tag).toBe("McpAuthRequiredError");
        expect(failure.message).not.toContain("wrong-token-value");
        expect(failure.message).not.toContain("sekret-token");
        expect(transport.state().lastError).not.toContain("wrong-token-value");
      },
    );
  });
});

describe("http transport - notification delivery failures", () => {
  it("records a non-2xx notification response as lastError without failing the transport", async () => {
    const fixture = await startFixtureHttpServer({ notificationStatus: 500 });
    const transport = createHttpTransport(httpConfig(fixture.endpoint));
    try {
      // initialize fires the notifications/initialized notification; the fixture rejects it.
      await transport.initialize();
      await expect.poll(() => transport.state().lastError ?? "").toContain("HTTP 500");
      // A notification delivery failure is recorded, never terminal.
      expect(transport.state().status).toBe("ready");
      expect(await callTool(transport, "echo", { text: "still up" })).toMatchObject({
        content: [{ type: "text", text: "still up" }],
      });
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
});

describe("http transport - session identity", () => {
  it("the fixture itself rejects a request that omits the session id", async () => {
    await withTransport({}, {}, async (transport, fixture) => {
      await transport.initialize();
      const raw = await fetch(fixture.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
      });
      expect(raw.status).toBe(404);
      expect(await raw.json()).toMatchObject({ error: { code: -32001 } });
    });
  });
});

describe("http transport - handshake failures", () => {
  it("rejects an unsupported server protocol version as a handshake failure", async () => {
    await withTransport({ protocolVersion: "1999-01-01" }, {}, async (transport) => {
      await expect(transport.initialize()).rejects.toMatchObject({
        _tag: "McpHandshakeError",
      });
      expect(transport.state().status).toBe("failed");
    });
  });

  it("classifies an unreachable endpoint as closed and fails the handshake", async () => {
    const fixture = await startFixtureHttpServer();
    await fixture.close(); // the port is now dead but was recently ours
    const transport = createHttpTransport(httpConfig(fixture.endpoint));
    try {
      await expect(transport.initialize()).rejects.toMatchObject({ _tag: "McpClosedError" });
      expect(transport.state().status).toBe("failed");
    } finally {
      await transport.close();
    }
  });
});

describe("http transport - lifecycle", () => {
  it("rejects requests after close", async () => {
    const fixture = await startFixtureHttpServer();
    const transport = createHttpTransport(httpConfig(fixture.endpoint));
    try {
      await transport.initialize();
      await transport.close();
      expect(transport.state().status).toBe("closed");
      await expect(transport.request("tools/list")).rejects.toMatchObject({
        _tag: "McpClosedError",
      });
    } finally {
      await fixture.close();
    }
  });

  it("drains an in-flight request when the transport closes", async () => {
    const fixture = await startFixtureHttpServer();
    const transport = createHttpTransport(httpConfig(fixture.endpoint));
    try {
      await transport.initialize();
      const hanging = expect(callTool(transport, "hang")).rejects.toMatchObject({
        _tag: "McpClosedError",
      });
      await transport.close();
      await hanging;
    } finally {
      await fixture.close();
    }
  });

  it("close is idempotent", async () => {
    const fixture = await startFixtureHttpServer();
    const transport = createHttpTransport(httpConfig(fixture.endpoint));
    try {
      await transport.initialize();
      await transport.close();
      await transport.close();
      expect(transport.state().status).toBe("closed");
    } finally {
      await fixture.close();
    }
  });
});
