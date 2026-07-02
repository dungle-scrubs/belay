import { DEFAULT_MCP_SEARCH_LIMIT, MAX_MCP_SEARCH_RESULTS } from "@host/mcp/capability-cache";
import type { McpServerConfig } from "@host/mcp/config";
import { createMcpRuntime, type McpRuntime } from "@host/mcp/runtime";
import { ToolInputError } from "@host/tools/errors";
import { buildMcpTool, type McpArgs } from "@host/tools/mcp";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { httpFixtureConfig, stdioFixtureArgs, stdioFixtureConfig } from "./fixture-config";
import { startFixtureHttpServer } from "./fixture-http-server";

/**
 * The model-facing `mcp` tool against REAL fixture servers (plan 23 M7): every action - search
 * (lazy discovery + caps), call, resources list/read, prompt list/get, status - through the
 * host tool boundary, over stdio and http, with qualified identity and redacted status output.
 */

async function withTool(
  servers: readonly McpServerConfig[],
  run: (execute: (args: McpArgs) => Promise<string>, runtime: McpRuntime) => Promise<void>,
): Promise<void> {
  const runtime = createMcpRuntime(servers);
  const tool = buildMcpTool(runtime);
  try {
    await run((args) => Effect.runPromise(tool.execute(args)), runtime);
  } finally {
    await runtime.close();
  }
}

describe("mcp tool - search across live servers", () => {
  it("discovers lazily and finds same-named tools on both servers by qualified identity", async () => {
    const fixture = await startFixtureHttpServer();
    try {
      await withTool(
        [stdioFixtureConfig("alpha"), httpFixtureConfig("beta", fixture.endpoint)],
        async (execute) => {
          const result = await execute({ action: "search", query: "echo" });
          expect(result).toContain("alpha:echo");
          expect(result).toContain("beta:echo");
          expect(result).toContain("[tool]");
        },
      );
    } finally {
      await fixture.close();
    }
  });

  it("caps results from a large catalog whatever limit is requested (D-003)", async () => {
    await withTool(
      [stdioFixtureConfig("big", { args: stdioFixtureArgs(["--catalog=large"]) })],
      async (execute) => {
        const capped = await execute({ action: "search", query: "bulk", limit: 10_000 });
        const cappedLines = capped.split("\n").filter((line) => line.startsWith("- "));
        expect(cappedLines.length).toBe(MAX_MCP_SEARCH_RESULTS);

        const defaulted = await execute({ action: "search", query: "bulk" });
        const defaultLines = defaulted.split("\n").filter((line) => line.startsWith("- "));
        expect(defaultLines.length).toBe(DEFAULT_MCP_SEARCH_LIMIT);
      },
    );
  });
});

describe("mcp tool - call", () => {
  it("runs a qualified tool call end to end", async () => {
    await withTool([stdioFixtureConfig("alpha")], async (execute) => {
      await expect(
        execute({ action: "call", name: "alpha:echo", args: { text: "via the tool" } }),
      ).resolves.toBe("via the tool");
    });
  });

  it("rejects an unknown server with a helpful typed input error", async () => {
    await withTool([stdioFixtureConfig("alpha")], async (_execute, runtime) => {
      const tool = buildMcpTool(runtime);
      const error = await Effect.runPromise(
        Effect.flip(tool.execute({ action: "call", name: "nope:echo" })),
      );
      expect(error).toBeInstanceOf(ToolInputError);
      expect(error.message).toContain('unknown MCP server "nope"');
    });
  });
});

describe("mcp tool - resources", () => {
  it("lists resources with provenance", async () => {
    await withTool([stdioFixtureConfig("alpha")], async (execute) => {
      const result = await execute({ action: "resources" });
      expect(result).toContain("alpha:readme");
      expect(result).toContain("fixture://readme");
      expect(result).toContain("text/plain");
    });
  });

  it("reads one resource as an attributed context record", async () => {
    await withTool([stdioFixtureConfig("alpha")], async (execute) => {
      const result = await execute({
        action: "resources",
        server: "alpha",
        uri: "fixture://readme",
      });
      expect(result).toContain("alpha");
      expect(result).toContain("fixture://readme");
      expect(result).toContain("fixture readme body");
    });
  });
});

describe("mcp tool - prompts", () => {
  it("lists prompts with qualified identity", async () => {
    await withTool([stdioFixtureConfig("alpha")], async (execute) => {
      const result = await execute({ action: "prompt" });
      expect(result).toContain("alpha:summarize");
      expect(result).toContain("alpha:greet");
    });
  });

  it("expands one prompt with server-side argument substitution", async () => {
    await withTool([stdioFixtureConfig("alpha")], async (execute) => {
      const result = await execute({
        action: "prompt",
        name: "alpha:summarize",
        args: { text: "the quarterly report" },
      });
      expect(result).toContain("Summarize the following text");
      expect(result).toContain("the quarterly report");
    });
  });
});

describe("mcp tool - status", () => {
  it("reports per-server health with redacted targets and no secrets", async () => {
    await withTool(
      [stdioFixtureConfig("alpha", { env: { FIXTURE_SECRET: "s3cret-env-value" } })],
      async (execute) => {
        await execute({ action: "call", name: "alpha:echo", args: { text: "warm" } });
        const result = await execute({ action: "status" });
        expect(result).toContain("alpha");
        expect(result).toContain("ready");
        expect(result).toContain("stdio");
        expect(result).not.toContain("s3cret-env-value");
      },
    );
  });

  it("shows capability counts and freshness once discovered", async () => {
    await withTool([stdioFixtureConfig("alpha")], async (execute) => {
      await execute({ action: "search", query: "echo" });
      const result = await execute({ action: "status" });
      expect(result).toMatch(/tools 2/);
      expect(result).toMatch(/resources 2/);
      expect(result).toMatch(/prompts 2/);
    });
  });
});
