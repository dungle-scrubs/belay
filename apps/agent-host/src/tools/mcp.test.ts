import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@belay/session";
import type { McpCapabilityRecord } from "@host/mcp/capabilities";
import {
  DEFAULT_MCP_SEARCH_LIMIT,
  MAX_MCP_SEARCH_RESULTS,
  type McpCapabilityCache,
} from "@host/mcp/capability-cache";
import type { McpRuntime, McpServerStatusEntry } from "@host/mcp/runtime";
import { ToolInputError } from "@host/tools/errors";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { buildMcpTool, type McpArgs } from "./mcp";

/**
 * The model-facing `mcp` tool surface (plan 23 M7), unit-tested against a FAKE runtime seam -
 * no transports, no I/O. Pins the D-001 guidance (MCP is generic; tool_proxy never appears),
 * the D-003 caps (search is the only discovery path, bounded), the D-005 qualified identity in
 * the guidance, the D-008 scheduling nature (never read-only), and the clean unconfigured
 * degradation. Live fixture-server behavior lives in test/mcp/tool.test.ts.
 */

function entry(overrides: Partial<McpServerStatusEntry> = {}): McpServerStatusEntry {
  return {
    server: "alpha",
    enabled: true,
    transport: "stdio",
    status: "configured",
    target: "/usr/local/bin/fixture",
    exposure: { tools: true, resources: true, prompts: true },
    capabilities: { discovered: false, counts: { tools: 0, resources: 0, prompts: 0 } },
    ...overrides,
  };
}

function fakeCache(overrides: Partial<McpCapabilityCache> = {}): McpCapabilityCache {
  return {
    refreshCapabilities: () => Promise.resolve(undefined),
    capabilitiesFor: () => undefined,
    searchCapabilities: () => [],
    snapshot: () => [],
    ...overrides,
  };
}

function fakeRuntime(
  entries: readonly McpServerStatusEntry[],
  overrides: Partial<McpRuntime> = {},
): McpRuntime {
  return {
    callTool: () => Effect.die("unexpected callTool"),
    listResources: () => Effect.succeed([]),
    readResource: () => Effect.die("unexpected readResource"),
    listPrompts: () => Effect.succeed([]),
    getPrompt: () => Effect.die("unexpected getPrompt"),
    capabilities: fakeCache(),
    statusSnapshot: () => entries,
    close: () => Promise.resolve(),
    ...overrides,
  };
}

const run = (runtime: McpRuntime, args: McpArgs) =>
  Effect.runPromise(buildMcpTool(runtime).execute(args));

const flip = (runtime: McpRuntime, args: McpArgs) =>
  Effect.runPromise(Effect.flip(buildMcpTool(runtime).execute(args)));

describe("mcp tool - guidance (D-001)", () => {
  const tool = buildMcpTool(fakeRuntime([]));

  test("describes MCP generically and never names tool_proxy", () => {
    expect(tool.description).toContain("MCP");
    expect(tool.description).not.toMatch(/tool[-_ ]proxy/i);
  });

  test("the description is bounded - guidance, not a catalog dump (D-003)", () => {
    expect(tool.description.length).toBeLessThan(1000);
  });

  test("examples use the qualified <server>:<name> identity (D-005)", () => {
    expect(tool.description).toContain("<server>:");
  });

  test("search is presented as the discovery path, with no full-catalog action", () => {
    expect(tool.description).toContain("search");
    expect(tool.description).not.toMatch(/\blist_all\b|full catalog listing/i);
  });
});

describe("mcp tool - scheduling classification (D-008)", () => {
  test("the mcp tool is a mutating serial barrier: readOnly unset, absent from the shared set", () => {
    const tool = buildMcpTool(fakeRuntime([]));
    expect(tool.readOnly).toBeUndefined();
    expect(READ_ONLY_TOOL_NAMES.has("mcp")).toBe(false);
  });

  test("the shared tool table carries mcp as NOT read-only (descriptor parity)", () => {
    const descriptor = TOOL_DESCRIPTORS.find((tool) => tool.name === "mcp");
    expect(descriptor).toBeDefined();
    expect(descriptor?.readOnly).toBe(false);
  });
});

describe("mcp tool - unconfigured MCP degrades cleanly", () => {
  test("every action reports no servers configured, as a success not an error", async () => {
    const runtime = fakeRuntime([]);
    for (const args of [
      { action: "status" },
      { action: "search", query: "issues" },
      { action: "call", name: "github:create_issue" },
      { action: "resources" },
      { action: "prompt" },
    ] satisfies McpArgs[]) {
      const result = await run(runtime, args);
      expect(result).toContain("No MCP servers are configured");
      expect(result).toContain("mcp-servers.json");
    }
  });

  test("an all-disabled registry says so instead of pretending to be empty", async () => {
    const runtime = fakeRuntime([entry({ enabled: false })]);
    const result = await run(runtime, { action: "status" });
    expect(result).toContain("disabled");
  });
});

describe("mcp tool - input validation", () => {
  const runtime = fakeRuntime([entry()]);

  test("search without a query is a typed input error (an empty query is a catalog dump)", async () => {
    const error = await flip(runtime, { action: "search" });
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain("query");
  });

  test("call without a name is a typed input error carrying the qualified-identity shape", async () => {
    const error = await flip(runtime, { action: "call" });
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain("<server>:<tool>");
  });

  test("a resource read (uri) without a server is a typed input error", async () => {
    const error = await flip(runtime, { action: "resources", uri: "fixture://readme" });
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain("server");
  });

  test("an unknown server surfaces the runtime's helpful ToolInputError", async () => {
    const failing = fakeRuntime([entry()], {
      callTool: () =>
        Effect.fail(new ToolInputError({ tool: "nope:echo", detail: 'unknown MCP server "nope"' })),
    });
    const error = await flip(failing, { action: "call", name: "nope:echo" });
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).detail).toContain('unknown MCP server "nope"');
  });
});

describe("mcp tool - search caps (D-003)", () => {
  const record = (name: string): McpCapabilityRecord => ({
    kind: "tool",
    server: "alpha",
    name,
    qualifiedName: `alpha:${name}`,
    description: `generated ${name}`,
  });

  test("an oversized limit is clamped to the hard cap before reaching the cache", async () => {
    const limits: number[] = [];
    const runtime = fakeRuntime(
      [
        entry({
          capabilities: { discovered: true, counts: { tools: 1, resources: 0, prompts: 0 } },
        }),
      ],
      {
        capabilities: fakeCache({
          searchCapabilities: (_query, options) => {
            limits.push(options?.limit ?? Number.NaN);
            return [record("echo")];
          },
        }),
      },
    );
    await run(runtime, { action: "search", query: "echo", limit: 10_000 });
    expect(limits).toEqual([MAX_MCP_SEARCH_RESULTS]);
  });

  test("an absent limit uses the default", async () => {
    const limits: number[] = [];
    const runtime = fakeRuntime(
      [
        entry({
          capabilities: { discovered: true, counts: { tools: 1, resources: 0, prompts: 0 } },
        }),
      ],
      {
        capabilities: fakeCache({
          searchCapabilities: (_query, options) => {
            limits.push(options?.limit ?? Number.NaN);
            return [];
          },
        }),
      },
    );
    await run(runtime, { action: "search", query: "echo" });
    expect(limits).toEqual([DEFAULT_MCP_SEARCH_LIMIT]);
  });

  test("search discovers undiscovered enabled servers first, tolerantly", async () => {
    const refreshed: string[] = [];
    const runtime = fakeRuntime(
      [
        entry({ server: "fresh" }),
        entry({
          server: "done",
          capabilities: { discovered: true, counts: { tools: 1, resources: 0, prompts: 0 } },
        }),
        entry({ server: "off", enabled: false }),
      ],
      {
        capabilities: fakeCache({
          refreshCapabilities: (server) => {
            refreshed.push(server);
            return Promise.reject(new Error("unreachable - must not fail the search"));
          },
        }),
      },
    );
    const result = await run(runtime, { action: "search", query: "echo" });
    expect(refreshed).toEqual(["fresh"]);
    expect(result).toContain("echo");
  });

  test("search skips servers whose transport fate is sealed (failed/closed)", async () => {
    // A dead server cannot answer discovery; retrying it would add its latency to every search.
    const refreshed: string[] = [];
    const runtime = fakeRuntime(
      [
        entry({ server: "fresh" }),
        entry({ server: "dead", status: "failed" }),
        entry({ server: "gone", status: "closed" }),
      ],
      {
        capabilities: fakeCache({
          refreshCapabilities: (server) => {
            refreshed.push(server);
            return Promise.resolve(undefined);
          },
        }),
      },
    );
    await run(runtime, { action: "search", query: "echo" });
    expect(refreshed).toEqual(["fresh"]);
  });
});
