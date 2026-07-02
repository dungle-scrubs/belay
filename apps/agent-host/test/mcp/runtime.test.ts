import { ToolExecutionError, ToolInputError } from "@host/tools/errors";
import { MAX_OUTPUT } from "@host/tools/shared";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/mcp/config";
import { createMcpRuntime, type McpRuntime } from "../../src/mcp/runtime";
import { httpFixtureConfig, stdioFixtureConfig } from "./fixture-config";
import { startFixtureHttpServer } from "./fixture-http-server";

/**
 * MCP runtime integration (plan 23 M5): drives the REAL fixture servers through the runtime's
 * host tool boundary - qualified calls over stdio AND http, schema'd argument round-trips,
 * bounded results, redacted typed failures, cancellation, and resource list/read as
 * provenance-carrying context records.
 */

async function withRuntime(
  servers: readonly McpServerConfig[],
  run: (runtime: McpRuntime) => Promise<void>,
): Promise<void> {
  const runtime = createMcpRuntime(servers);
  try {
    await run(runtime);
  } finally {
    await runtime.close();
  }
}

const call = (runtime: McpRuntime, name: string, args?: Record<string, unknown>) =>
  Effect.runPromise(runtime.callTool(name, args));

const flipCall = (runtime: McpRuntime, name: string, args?: Record<string, unknown>) =>
  Effect.runPromise(Effect.flip(runtime.callTool(name, args)));

describe("mcp runtime - qualified tool calls", () => {
  it("calls a qualified tool over stdio, connecting lazily on first use", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      expect(runtime.statusSnapshot()[0]?.status).toBe("configured");
      await expect(call(runtime, "alpha:echo", { text: "hello over stdio" })).resolves.toBe(
        "hello over stdio",
      );
      expect(runtime.statusSnapshot()[0]).toMatchObject({
        server: "alpha",
        status: "ready",
        protocolVersion: expect.any(String),
      });
    });
  });

  it("calls a qualified tool over http", async () => {
    const fixture = await startFixtureHttpServer();
    try {
      await withRuntime([httpFixtureConfig("beta", fixture.endpoint)], async (runtime) => {
        await expect(call(runtime, "beta:echo", { text: "hello over http" })).resolves.toBe(
          "hello over http",
        );
        expect(runtime.statusSnapshot()[0]?.status).toBe("ready");
      });
    } finally {
      await fixture.close();
    }
  });

  it("routes same-named tools by qualified identity across two live servers (D-005)", async () => {
    const fixture = await startFixtureHttpServer();
    try {
      await withRuntime(
        [stdioFixtureConfig("alpha"), httpFixtureConfig("beta", fixture.endpoint)],
        async (runtime) => {
          const [fromAlpha, fromBeta] = await Promise.all([
            call(runtime, "alpha:echo", { text: "alpha says" }),
            call(runtime, "beta:echo", { text: "beta says" }),
          ]);
          expect(fromAlpha).toBe("alpha says");
          expect(fromBeta).toBe("beta says");
        },
      );
    } finally {
      await fixture.close();
    }
  });

  it("passes JSON-schema'd arguments through unchanged", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const args = {
        text: "héllo 世界",
        count: 3,
        nested: { flags: [true, false], label: "deep" },
      };
      const echoed = await call(runtime, "alpha:args_probe", args);
      expect(JSON.parse(echoed)).toEqual(args);
    });
  });

  it("caps an oversized tool result with the host truncation marker", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const result = await call(runtime, "alpha:big", { chars: MAX_OUTPUT * 3 });
      expect(result.length).toBeLessThanOrEqual(MAX_OUTPUT + "\n…[truncated]".length);
      expect(result.endsWith("…[truncated]")).toBe(true);
    });
  });
});

describe("mcp runtime - failures", () => {
  it("classifies a JSON-RPC tool failure as a typed ToolExecutionError", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const error = await flipCall(runtime, "alpha:boom");
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect(error.message).toContain("boom tool always fails");
      // A per-request failure does not take the server down.
      await expect(call(runtime, "alpha:echo", { text: "still up" })).resolves.toBe("still up");
    });
  });

  it("classifies an isError tool result as a ToolExecutionError with the bounded content", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const error = await flipCall(runtime, "alpha:soft_fail");
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect(error.message).toContain("external service exploded");
    });
  });

  it("never leaks bearer tokens through an auth failure (redacted errors)", async () => {
    const fixture = await startFixtureHttpServer({ requireBearer: "sekret-token" });
    try {
      await withRuntime(
        [httpFixtureConfig("beta", fixture.endpoint, { auth: { bearerToken: "wrong-token" } })],
        async (runtime) => {
          const error = await flipCall(runtime, "beta:echo", { text: "hi" });
          expect(error).toBeInstanceOf(ToolExecutionError);
          expect(error.message).toContain("authentication");
          expect(error.message).not.toContain("wrong-token");
          expect(error.message).not.toContain("sekret-token");
          expect(runtime.statusSnapshot()[0]?.status).toBe("auth_needed");
          expect(JSON.stringify(runtime.statusSnapshot())).not.toContain("wrong-token");
        },
      );
    } finally {
      await fixture.close();
    }
  });

  it("attributes an unknown-tool call to the qualified name", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const error = await flipCall(runtime, "alpha:no_such_tool");
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect((error as ToolExecutionError).tool).toBe("alpha:no_such_tool");
    });
  });
});

describe("mcp runtime - cancellation", () => {
  it("interrupts a hanging call like any other tool and keeps the server usable", async () => {
    const fixture = await startFixtureHttpServer();
    try {
      await withRuntime([httpFixtureConfig("beta", fixture.endpoint)], async (runtime) => {
        // Warm the connection so the interrupt hits the in-flight request, not the handshake.
        await call(runtime, "beta:echo", { text: "warm" });
        const fiber = Effect.runFork(runtime.callTool("beta:hang"));
        // The condition, not a fixed sleep: the hang request has REACHED the server (the warm
        // echo was tools/call #1, the hang is #2), so the interrupt hits an in-flight request.
        await expect
          .poll(() => fixture.requests().filter((entry) => entry.method === "tools/call").length)
          .toBeGreaterThanOrEqual(2);
        const exit = await Effect.runPromise(Fiber.interrupt(fiber));
        expect(Exit.isInterrupted(exit)).toBe(true);
        // The transport is not wedged: the same server still answers.
        await expect(call(runtime, "beta:echo", { text: "after interrupt" })).resolves.toBe(
          "after interrupt",
        );
      });
    } finally {
      await fixture.close();
    }
  });
});

describe("mcp runtime - resources as context records", () => {
  it("lists resources with server provenance and qualified identity", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const resources = await Effect.runPromise(runtime.listResources("alpha"));
      expect(resources).toMatchObject([
        {
          kind: "resource",
          server: "alpha",
          qualifiedName: "alpha:readme",
          uri: "fixture://readme",
          mimeType: "text/plain",
        },
        { qualifiedName: "alpha:daily_log", uri: "fixture://logs/today" },
      ]);
    });
  });

  it("reads a resource into a bounded, provenance-carrying context record", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const record = await Effect.runPromise(runtime.readResource("alpha", "fixture://readme"));
      expect(record).toMatchObject({
        kind: "mcp_resource",
        server: "alpha",
        uri: "fixture://readme",
        mimeType: "text/plain",
        truncated: false,
      });
      expect(record.text).toContain("fixture readme");
    });
  });

  it("bounds an oversized resource and flags the truncation", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const record = await Effect.runPromise(runtime.readResource("alpha", "fixture://big"));
      expect(record.truncated).toBe(true);
      expect(record.text.length).toBeLessThanOrEqual(MAX_OUTPUT + "\n…[truncated]".length);
    });
  });

  it("describes a binary resource instead of dumping base64", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const record = await Effect.runPromise(runtime.readResource("alpha", "fixture://blob"));
      expect(record.text).toMatch(/^\[binary application\/octet-stream, \d+ base64 chars\]$/);
    });
  });

  it("reads resources over http too", async () => {
    const fixture = await startFixtureHttpServer();
    try {
      await withRuntime([httpFixtureConfig("beta", fixture.endpoint)], async (runtime) => {
        const record = await Effect.runPromise(runtime.readResource("beta", "fixture://readme"));
        expect(record).toMatchObject({ server: "beta", uri: "fixture://readme" });
        expect(record.text).toContain("fixture readme");
      });
    } finally {
      await fixture.close();
    }
  });

  it("fails a read of an unknown resource as a typed execution error", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const error = await Effect.runPromise(
        Effect.flip(runtime.readResource("alpha", "fixture://nope")),
      );
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect(error.message).toContain("resource not found");
    });
  });

  it("rejects resource reads on an unknown server with a typed input error", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const error = await Effect.runPromise(
        Effect.flip(runtime.readResource("nope", "fixture://readme")),
      );
      expect(error).toBeInstanceOf(ToolInputError);
    });
  });
});

describe("mcp runtime - status snapshot failure detail", () => {
  it("surfaces a failed discovery in the snapshot's capability freshness (with error tags)", async () => {
    await withRuntime(
      [
        stdioFixtureConfig("alpha", {
          command: "/nonexistent/trevor-mcp-fixture-binary",
          args: [],
        }),
      ],
      async (runtime) => {
        await Effect.runPromise(Effect.flip(runtime.listResources("alpha")));
        const entry = runtime.statusSnapshot()[0];
        expect(entry?.status).toBe("failed");
        expect(entry?.lastErrorTag).toBe("McpServerCrashError");
        expect(entry?.capabilities.discovered).toBe(false);
        expect(entry?.capabilities.lastError).toContain("crashed");
      },
    );
  });
});
