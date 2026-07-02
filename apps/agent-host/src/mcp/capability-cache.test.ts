import { describe, expect, test } from "vitest";
import type { McpCapabilitySource } from "./capability-cache";
import {
  createMcpCapabilityCache,
  DEFAULT_MCP_SEARCH_LIMIT,
  MAX_MCP_SEARCH_RESULTS,
} from "./capability-cache";
import type { McpServerConfig } from "./config";
import { McpTimeoutError } from "./errors";
import type { McpTransport } from "./transport";

function stdioConfig(name: string): McpServerConfig {
  return {
    name,
    enabled: true,
    transport: "stdio",
    command: "unused",
    args: [],
    env: {},
    exposure: { tools: true, resources: true, prompts: true },
    requestTimeoutMs: 5_000,
  };
}

function stubSource(
  name: string,
  tools: readonly { name: string; description?: string }[],
  config: McpServerConfig = stdioConfig(name),
): McpCapabilitySource {
  const transport: McpTransport = {
    initialize: () => Promise.resolve({ protocolVersion: "2025-06-18", capabilities: {} }),
    request: (method) => {
      if (method === "tools/list") {
        return Promise.resolve({ tools });
      }
      return Promise.resolve({ resources: [], prompts: [] });
    },
    notify: () => {},
    close: () => Promise.resolve(),
    state: () => ({ status: "ready", initialized: true }),
  };
  return { config, transport };
}

describe("capability cache - refresh", () => {
  test("returns undefined for a server the cache does not know", async () => {
    const cache = createMcpCapabilityCache([stubSource("alpha", [])]);
    await expect(cache.refreshCapabilities("nope")).resolves.toBeUndefined();
  });

  test("populates the cache and returns the fresh discovery", async () => {
    const cache = createMcpCapabilityCache([stubSource("alpha", [{ name: "echo" }])]);
    const discovered = await cache.refreshCapabilities("alpha");
    expect(discovered?.tools.map((tool) => tool.qualifiedName)).toEqual(["alpha:echo"]);
  });

  test("capabilitiesFor reads the cache without talking to the server", async () => {
    const cache = createMcpCapabilityCache([stubSource("alpha", [{ name: "echo" }])]);
    expect(cache.capabilitiesFor("alpha")).toBeUndefined(); // nothing discovered yet
    expect(cache.capabilitiesFor("nope")).toBeUndefined();
    await cache.refreshCapabilities("alpha");
    expect(cache.capabilitiesFor("alpha")?.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  test("records the failure in the snapshot and rethrows when discovery fails", async () => {
    const failing: McpCapabilitySource = {
      config: stdioConfig("alpha"),
      transport: {
        initialize: () =>
          Promise.reject(
            new McpTimeoutError({ server: "alpha", method: "initialize", timeoutMs: 10 }),
          ),
        request: () => Promise.reject(new Error("unused")),
        notify: () => {},
        close: () => Promise.resolve(),
        state: () => ({ status: "configured", initialized: false }),
      },
    };
    const cache = createMcpCapabilityCache([failing]);
    await expect(cache.refreshCapabilities("alpha")).rejects.toMatchObject({
      _tag: "McpTimeoutError",
    });
    expect(cache.snapshot()).toMatchObject([
      { server: "alpha", discovered: false, lastError: expect.stringContaining("timed out") },
    ]);
  });
});

describe("capability cache - search (D-003 capped exposure)", () => {
  const ranked = stubSource("srv", [
    { name: "anchor", description: "exact" },
    { name: "anchor_extra", description: "prefix" },
    { name: "grand_anchor_tool", description: "substring" },
    { name: "plainly_named", description: "matches anchor only in the description" },
    { name: "unrelated", description: "nothing to see" },
  ]);

  test("ranks name matches above description matches, alphabetical within a rank", async () => {
    const cache = createMcpCapabilityCache([ranked]);
    await cache.refreshCapabilities("srv");
    expect(cache.searchCapabilities("Anchor").map((record) => record.qualifiedName)).toEqual([
      "srv:anchor",
      "srv:anchor_extra",
      "srv:grand_anchor_tool",
      "srv:plainly_named",
    ]);
  });

  test("an empty query exposes nothing (no full-catalog dumps)", async () => {
    const cache = createMcpCapabilityCache([ranked]);
    await cache.refreshCapabilities("srv");
    expect(cache.searchCapabilities("")).toEqual([]);
    expect(cache.searchCapabilities("   ")).toEqual([]);
  });

  test("respects the requested limit and clamps it to the hard cap", async () => {
    const many = stubSource(
      "big",
      Array.from({ length: 200 }, (_, index) => ({ name: `bulk_${index}` })),
    );
    const cache = createMcpCapabilityCache([many]);
    await cache.refreshCapabilities("big");

    expect(cache.searchCapabilities("bulk")).toHaveLength(DEFAULT_MCP_SEARCH_LIMIT);
    expect(cache.searchCapabilities("bulk", { limit: 5 })).toHaveLength(5);
    expect(cache.searchCapabilities("bulk", { limit: 10_000 })).toHaveLength(
      MAX_MCP_SEARCH_RESULTS,
    );
  });

  test("duplicate simple names across servers coexist under qualified identity (D-005)", async () => {
    const cache = createMcpCapabilityCache([
      stubSource("alpha", [{ name: "echo" }]),
      stubSource("beta", [{ name: "echo" }]),
    ]);
    await cache.refreshCapabilities("alpha");
    await cache.refreshCapabilities("beta");

    const hits = cache.searchCapabilities("echo");
    expect(hits.map((record) => record.qualifiedName)).toEqual(["alpha:echo", "beta:echo"]);
    expect(new Set(hits.map((record) => record.server))).toEqual(new Set(["alpha", "beta"]));
  });
});

describe("capability cache - snapshot (D-009 freshness without transports)", () => {
  test("lists every configured server before any discovery ran", () => {
    const cache = createMcpCapabilityCache([stubSource("alpha", []), stubSource("beta", [])]);
    expect(cache.snapshot()).toEqual([
      { server: "alpha", discovered: false, counts: { tools: 0, resources: 0, prompts: 0 } },
      { server: "beta", discovered: false, counts: { tools: 0, resources: 0, prompts: 0 } },
    ]);
  });

  test("carries counts and the injected clock's discovery time after a refresh", async () => {
    let nowMs = 1_000;
    const cache = createMcpCapabilityCache([stubSource("alpha", [{ name: "echo" }])], {
      now: () => nowMs,
    });
    await cache.refreshCapabilities("alpha");
    expect(cache.snapshot()).toEqual([
      {
        server: "alpha",
        discovered: true,
        discoveredAt: 1_000,
        counts: { tools: 1, resources: 0, prompts: 0 },
      },
    ]);

    nowMs = 2_000;
    await cache.refreshCapabilities("alpha");
    expect(cache.snapshot()[0]).toMatchObject({ discoveredAt: 2_000 });
  });

  test("is plain serializable data - no functions, no transport handles", async () => {
    const cache = createMcpCapabilityCache([stubSource("alpha", [{ name: "echo" }])]);
    await cache.refreshCapabilities("alpha");
    const snapshot = cache.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
