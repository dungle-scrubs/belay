import { describe, expect, it } from "vitest";
import type { McpStdioServerConfig } from "../../src/mcp/config";
import { STDIO_CHILD_ENV_ALLOWLIST, spawnStdioTransport } from "../../src/mcp/stdio-transport";
import { MCP_PROTOCOL_VERSION, type McpTransport } from "../../src/mcp/transport";
import { stdioFixtureArgs, stdioFixtureConfig } from "./fixture-config";

/**
 * Stdio transport integration (plan 23 M2): drives the REAL fixture MCP server (a spawned child
 * speaking Content-Length-framed JSON-RPC over pipes) through handshake, tool calls, error
 * triggers, lifecycle edges, and the D-004 env probe.
 */

/** The shared stdio fixture config under this suite's name and tighter 5s deadline. */
function fixtureConfig(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return stdioFixtureConfig("fixture", { requestTimeoutMs: 5_000, ...overrides });
}

async function withTransport(
  config: McpStdioServerConfig,
  run: (transport: McpTransport) => Promise<void>,
): Promise<void> {
  const transport = spawnStdioTransport(config);
  try {
    await run(transport);
  } finally {
    await transport.close();
  }
}

function callTool(transport: McpTransport, name: string, args: Record<string, unknown> = {}) {
  return transport.request("tools/call", { name, arguments: args });
}

function textContent(response: unknown): string {
  const content = (response as { content: readonly { text: string }[] }).content;
  return content[0]?.text ?? "";
}

describe("stdio transport - handshake", () => {
  it("initializes: negotiates the protocol version and reaches ready", async () => {
    await withTransport(fixtureConfig(), async (transport) => {
      const init = await transport.initialize();
      expect(init.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(init.serverInfo).toMatchObject({ name: "trevor-mcp-fixture" });
      expect(transport.state()).toMatchObject({
        status: "ready",
        initialized: true,
        protocolVersion: MCP_PROTOCOL_VERSION,
      });
    });
  });

  it("rejects an unsupported server protocol version as a handshake failure", async () => {
    await withTransport(
      fixtureConfig({ args: stdioFixtureArgs(["--protocol=1999-01-01"]) }),
      async (transport) => {
        await expect(transport.initialize()).rejects.toMatchObject({
          _tag: "McpHandshakeError",
        });
        expect(transport.state().status).toBe("failed");
      },
    );
  });

  it("classifies a command that cannot spawn as a server crash", async () => {
    await withTransport(
      fixtureConfig({ command: "/nonexistent/trevor-mcp-fixture-binary", args: [] }),
      async (transport) => {
        await expect(transport.initialize()).rejects.toMatchObject({
          _tag: "McpServerCrashError",
        });
        expect(transport.state().status).toBe("failed");
      },
    );
  });

  it("a handshake timeout is TERMINAL: the transport fails instead of wedging as configured", async () => {
    await withTransport(
      fixtureConfig({ requestTimeoutMs: 300, args: stdioFixtureArgs(["--init=hang"]) }),
      async (transport) => {
        await expect(transport.initialize()).rejects.toMatchObject({ _tag: "McpTimeoutError" });
        // No zombie: the child is reaped and the state is machine-classifiable for /doctor.
        expect(transport.state()).toMatchObject({
          status: "failed",
          initialized: false,
          lastErrorTag: "McpTimeoutError",
        });
        // The sealed fate answers later requests too - nothing ever waits on the dead child.
        await expect(transport.request("tools/list")).rejects.toMatchObject({
          _tag: "McpTimeoutError",
        });
      },
    );
  });
});

describe("stdio transport - requests", () => {
  it("lists tools", async () => {
    await withTransport(fixtureConfig(), async (transport) => {
      await transport.initialize();
      const response = (await transport.request("tools/list")) as {
        tools: readonly { name: string }[];
      };
      expect(response.tools.map((tool) => tool.name)).toEqual(["echo", "env_probe"]);
    });
  });

  it("round-trips a multibyte tool result through real frames", async () => {
    await withTransport(fixtureConfig(), async (transport) => {
      await transport.initialize();
      const response = await callTool(transport, "echo", { text: "héllo 世界 🎈" });
      expect(textContent(response)).toBe("héllo 世界 🎈");
    });
  });

  it("correlates concurrent responses to their requests by id", async () => {
    await withTransport(fixtureConfig(), async (transport) => {
      await transport.initialize();
      const [one, two, three] = await Promise.all([
        callTool(transport, "echo", { text: "one" }),
        callTool(transport, "echo", { text: "two" }),
        callTool(transport, "echo", { text: "三" }),
      ]);
      expect([textContent(one), textContent(two), textContent(three)]).toEqual([
        "one",
        "two",
        "三",
      ]);
    });
  });

  it("surfaces a JSON-RPC error as a typed rpc failure and stays usable", async () => {
    await withTransport(fixtureConfig(), async (transport) => {
      await transport.initialize();
      await expect(callTool(transport, "boom")).rejects.toMatchObject({
        _tag: "McpRpcError",
        code: -32001,
      });
      // A per-request JSON-RPC error is not a transport failure.
      expect(transport.state().status).toBe("ready");
      const response = await callTool(transport, "echo", { text: "still here" });
      expect(textContent(response)).toBe("still here");
    });
  });

  it("times out a request the server never answers", async () => {
    await withTransport(fixtureConfig({ requestTimeoutMs: 300 }), async (transport) => {
      await transport.initialize();
      await expect(callTool(transport, "hang")).rejects.toMatchObject({
        _tag: "McpTimeoutError",
        timeoutMs: 300,
      });
    });
  });

  it("classifies a well-framed non-JSON response as malformed and fails the transport", async () => {
    await withTransport(fixtureConfig(), async (transport) => {
      await transport.initialize();
      await expect(callTool(transport, "garbage")).rejects.toMatchObject({
        _tag: "McpMalformedResponseError",
      });
      expect(transport.state().status).toBe("failed");
    });
  });
});

describe("stdio transport - lifecycle", () => {
  it("drains pending requests when the child crashes and fails later requests", async () => {
    await withTransport(fixtureConfig(), async (transport) => {
      await transport.initialize();
      await expect(callTool(transport, "crash")).rejects.toMatchObject({
        _tag: "McpServerCrashError",
      });
      expect(transport.state().status).toBe("failed");
      await expect(callTool(transport, "echo", { text: "late" })).rejects.toMatchObject({
        _tag: "McpServerCrashError",
      });
    });
  });

  it("rejects requests after close", async () => {
    const transport = spawnStdioTransport(fixtureConfig());
    await transport.initialize();
    await transport.close();
    expect(transport.state().status).toBe("closed");
    await expect(transport.request("tools/list")).rejects.toMatchObject({
      _tag: "McpClosedError",
    });
  });

  it("drains in-flight requests when the connection closes", async () => {
    const transport = spawnStdioTransport(fixtureConfig());
    await transport.initialize();
    // Attach the rejection handler before close() so the drain is observed, not unhandled.
    const hanging = expect(callTool(transport, "hang")).rejects.toMatchObject({
      _tag: "McpClosedError",
    });
    await transport.close();
    await hanging;
  });

  it("close is idempotent", async () => {
    const transport = spawnStdioTransport(fixtureConfig());
    await transport.initialize();
    await transport.close();
    await transport.close();
    expect(transport.state().status).toBe("closed");
  });
});

describe("stdio transport - stderr scrubbing (crash details reach /doctor and the UI)", () => {
  it("scrubs server env VALUES out of the crash detail's stderr tail", async () => {
    await withTransport(
      fixtureConfig({ env: { MCP_FIXTURE_SECRET: "stderr-s3cret-value" } }),
      async (transport) => {
        await transport.initialize();
        const failure = await callTool(transport, "crash_loud").then(
          () => {
            throw new Error("crash_loud should have failed");
          },
          (error: unknown) => error as { _tag: string; message: string },
        );
        expect(failure._tag).toBe("McpServerCrashError");
        expect(failure.message).toContain("stderr tail");
        expect(failure.message).toContain("[redacted]");
        expect(failure.message).not.toContain("stderr-s3cret-value");
        expect(transport.state().lastError).not.toContain("stderr-s3cret-value");
      },
    );
  });
});

describe("stdio transport - D-004 env probe", () => {
  it("leaks no provider/API-key env vars; child sees allowlist + explicit server env only", async () => {
    const planted = {
      OPENAI_API_KEY: "sk-fake-openai",
      ANTHROPIC_API_KEY: "sk-ant-fake",
      DEEPSEEK_API_KEY: "dk-fake",
      ZAI_API_KEY: "zai-fake",
      MINIMAX_API_KEY: "mm-fake",
      OPENROUTER_API_KEY: "or-fake",
      TREVOR_FAKE_SECRET: "trevor-fake",
      SESSION_ID: "sess-fake",
    };
    const previous = new Map(Object.keys(planted).map((name) => [name, process.env[name]]));
    Object.assign(process.env, planted);
    try {
      await withTransport(fixtureConfig({ env: { MCP_FIXTURE_FLAG: "on" } }), async (transport) => {
        await transport.initialize();
        const response = await callTool(transport, "env_probe");
        const childEnv = JSON.parse(textContent(response)) as Record<string, string>;

        for (const name of Object.keys(planted)) {
          expect(childEnv, `${name} must not leak into the MCP child`).not.toHaveProperty(name);
        }
        // The full invariant: every var the child sees is allowlisted or explicitly granted.
        // (__CF_USER_TEXT_ENCODING is injected by macOS into every process, not by our spawn.)
        const granted = new Set<string>([
          ...STDIO_CHILD_ENV_ALLOWLIST,
          "MCP_FIXTURE_FLAG",
          "__CF_USER_TEXT_ENCODING",
        ]);
        expect(Object.keys(childEnv).filter((name) => !granted.has(name))).toEqual([]);
        expect(childEnv.PATH).toBeTruthy();
        expect(childEnv.MCP_FIXTURE_FLAG).toBe("on");
      });
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});
