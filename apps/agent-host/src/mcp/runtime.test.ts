import { partitionToolCalls } from "@host/agent/loop-tool-calls";
import { ToolExecutionError, ToolInputError } from "@host/tools/errors";
import { READ_ONLY_TOOL_NAMES } from "@trevor/session";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type { McpServerConfig } from "./config";
import { createMcpRuntime } from "./runtime";

/**
 * Runtime unit tests: laziness, qualified-identity resolution failures, the D-008 scheduling
 * classification, and status snapshots - all without any real server I/O (nothing here may
 * spawn a child or open a socket; the configs point at targets that would fail loudly if the
 * runtime were eager). Live-fixture behavior is covered in test/mcp/runtime.test.ts.
 */

function stdioConfig(name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    enabled: true,
    transport: "stdio",
    command: "/nonexistent/never-spawned-mcp-binary",
    args: ["--secret-arg=s3cret"],
    env: {},
    exposure: { tools: true, resources: true, prompts: true },
    requestTimeoutMs: 5_000,
    ...overrides,
  } as McpServerConfig;
}

function httpConfig(name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    enabled: true,
    transport: "http",
    endpoint: "http://127.0.0.1:1/mcp?token=s3cret",
    exposure: { tools: true, resources: true, prompts: true },
    requestTimeoutMs: 5_000,
    ...overrides,
  } as McpServerConfig;
}

const flip = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(Effect.flip(effect));

describe("mcp runtime - lazy construction", () => {
  test("constructing the runtime connects nothing: every server stays configured", () => {
    const runtime = createMcpRuntime([stdioConfig("alpha"), httpConfig("beta")]);
    expect(runtime.statusSnapshot().map((entry) => [entry.server, entry.status])).toEqual([
      ["alpha", "configured"],
      ["beta", "configured"],
    ]);
  });

  test("a disabled server is visible in the snapshot but never eligible for calls", async () => {
    const runtime = createMcpRuntime([stdioConfig("off", { enabled: false })]);
    expect(runtime.statusSnapshot()).toMatchObject([
      { server: "off", enabled: false, status: "configured" },
    ]);
    const error = await flip(runtime.callTool("off:echo", {}));
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain("disabled");
    // Still nothing connected.
    expect(runtime.statusSnapshot()[0]?.status).toBe("configured");
  });
});

describe("mcp runtime - qualified identity resolution", () => {
  test("rejects an unqualified tool name with guidance", async () => {
    const runtime = createMcpRuntime([stdioConfig("alpha")]);
    const error = await flip(runtime.callTool("echo", {}));
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain("<server>:<name>");
  });

  test("rejects an unknown server", async () => {
    const runtime = createMcpRuntime([stdioConfig("alpha")]);
    const error = await flip(runtime.callTool("nope:echo", {}));
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain('unknown MCP server "nope"');
  });

  test("rejects a call to a server that does not expose tools (D-002)", async () => {
    const runtime = createMcpRuntime([
      stdioConfig("alpha", { exposure: { tools: false, resources: true, prompts: true } }),
    ]);
    const error = await flip(runtime.callTool("alpha:echo", {}));
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain("does not expose tools");
  });

  test("rejects a resource read on a server that does not expose resources (D-002)", async () => {
    const runtime = createMcpRuntime([
      stdioConfig("alpha", { exposure: { tools: true, resources: false, prompts: true } }),
    ]);
    const error = await flip(runtime.readResource("alpha", "fixture://readme"));
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain("does not expose resources");
  });
});

describe("mcp runtime - D-008 scheduling classification", () => {
  test("no MCP qualified name is in the shared read-only vocabulary", () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(name).not.toContain(":");
      expect(name.startsWith("mcp")).toBe(false);
    }
  });

  test("an external MCP tool call partitions as a serial barrier, not a concurrent read", () => {
    const call = (id: string, name: string) => ({ id, name, arguments: "{}" });
    const segments = partitionToolCalls([
      call("1", "read"),
      call("2", "github:create_issue"),
      call("3", "glob"),
    ]);
    // The MCP call breaks the read run: three segments, the MCP call alone in the middle.
    expect(segments.map((segment) => segment.map((entry) => entry.call.name))).toEqual([
      ["read"],
      ["github:create_issue"],
      ["glob"],
    ]);
  });
});

describe("mcp runtime - status snapshot redaction (D-009)", () => {
  test("targets are redacted: stdio shows the command word, http drops query secrets", () => {
    const runtime = createMcpRuntime([stdioConfig("alpha"), httpConfig("beta")]);
    const [alpha, beta] = runtime.statusSnapshot();
    expect(alpha?.target).toBe("/nonexistent/never-spawned-mcp-binary");
    expect(alpha?.target).not.toContain("s3cret");
    expect(beta?.target).toBe("http://127.0.0.1:1/mcp");
    expect(beta?.target).not.toContain("s3cret");
  });

  test("snapshot carries transport, exposure, and empty capability counts before discovery", () => {
    const runtime = createMcpRuntime([stdioConfig("alpha")]);
    expect(runtime.statusSnapshot()).toEqual([
      {
        server: "alpha",
        enabled: true,
        transport: "stdio",
        status: "configured",
        target: "/nonexistent/never-spawned-mcp-binary",
        exposure: { tools: true, resources: true, prompts: true },
        capabilities: {
          discovered: false,
          counts: { tools: 0, resources: 0, prompts: 0 },
        },
      },
    ]);
  });
});

describe("mcp runtime - close", () => {
  test("after close every call fails closed without ever connecting", async () => {
    const runtime = createMcpRuntime([stdioConfig("alpha")]);
    await runtime.close();
    const error = await flip(runtime.callTool("alpha:echo", {}));
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as ToolExecutionError).detail).toContain("closed");
    expect(runtime.statusSnapshot()[0]?.status).toBe("closed");
  });

  test("close is idempotent", async () => {
    const runtime = createMcpRuntime([stdioConfig("alpha")]);
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
