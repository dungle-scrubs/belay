import { describe, expect, it } from "vitest";
import type { McpCapabilityCache, McpCapabilitySource } from "../../src/mcp/capability-cache";
import {
  createMcpCapabilityCache,
  DEFAULT_MCP_SEARCH_LIMIT,
  MAX_MCP_SEARCH_RESULTS,
} from "../../src/mcp/capability-cache";
import type { McpStdioServerConfig } from "../../src/mcp/config";
import { spawnStdioTransport } from "../../src/mcp/stdio-transport";
import { type FixtureCatalogMode, LARGE_CATALOG_SIZE } from "./fixture-catalog";
import { stdioFixtureArgs, stdioFixtureConfig } from "./fixture-config";

/**
 * Capability cache integration (plan 23 M4): refresh and capped search over REAL fixture
 * servers - the D-003 guarantee that a 500-tool catalog is only ever exposed through ranked,
 * capped search results, refresh re-reads the live server, and the /doctor freshness snapshot
 * is plain data with no transport access.
 */

/** The shared stdio fixture config, optionally serving a non-default ./fixture-catalog mode. */
function stdioConfig(name: string, catalog?: FixtureCatalogMode): McpStdioServerConfig {
  return stdioFixtureConfig(
    name,
    catalog ? { args: stdioFixtureArgs([`--catalog=${catalog}`]) } : {},
  );
}

async function withCache(
  configs: readonly McpStdioServerConfig[],
  run: (cache: McpCapabilityCache) => Promise<void>,
): Promise<void> {
  const sources: McpCapabilitySource[] = configs.map((config) => ({
    config,
    transport: spawnStdioTransport(config),
  }));
  try {
    await run(createMcpCapabilityCache(sources));
  } finally {
    await Promise.all(sources.map((source) => source.transport.close()));
  }
}

describe("capability cache over a real large catalog (D-003)", () => {
  it("caps search results and never exposes the full catalog", async () => {
    await withCache([stdioConfig("big", "large")], async (cache) => {
      const discovered = await cache.refreshCapabilities("big");
      expect(discovered?.tools).toHaveLength(LARGE_CATALOG_SIZE);

      // "bulk" matches ~496 generated tools; the search result never carries them all.
      const defaulted = cache.searchCapabilities("bulk");
      expect(defaulted).toHaveLength(DEFAULT_MCP_SEARCH_LIMIT);

      expect(cache.searchCapabilities("bulk", { limit: 10 })).toHaveLength(10);

      const clamped = cache.searchCapabilities("bulk", { limit: 10_000 });
      expect(clamped).toHaveLength(MAX_MCP_SEARCH_RESULTS);
      expect(clamped.length).toBeLessThan(LARGE_CATALOG_SIZE);
    });
  });

  it("ranks search hits: exact name, then prefix, then substring, then description", async () => {
    await withCache([stdioConfig("big", "large")], async (cache) => {
      await cache.refreshCapabilities("big");
      expect(cache.searchCapabilities("anchor").map((record) => record.qualifiedName)).toEqual([
        "big:anchor",
        "big:anchor_extra",
        "big:grand_anchor_tool",
        "big:plainly_named",
      ]);
    });
  });

  it("finds resources and prompts through the same search surface", async () => {
    await withCache([stdioConfig("big", "large")], async (cache) => {
      await cache.refreshCapabilities("big");
      expect(cache.searchCapabilities("readme")).toMatchObject([
        { kind: "resource", qualifiedName: "big:readme", uri: "fixture://readme" },
      ]);
      expect(cache.searchCapabilities("summarize")).toMatchObject([
        { kind: "prompt", qualifiedName: "big:summarize" },
      ]);
    });
  });
});

describe("capability cache refresh against a live server", () => {
  it("re-reads the server: a refresh observes catalog changes", async () => {
    await withCache([stdioConfig("counter", "counting")], async (cache) => {
      const first = await cache.refreshCapabilities("counter");
      const probeOne = first?.tools.find((tool) => tool.name === "refresh_probe");
      expect(probeOne?.description).toBe("tools/list call #1");

      const second = await cache.refreshCapabilities("counter");
      const probeTwo = second?.tools.find((tool) => tool.name === "refresh_probe");
      expect(probeTwo?.description).toBe("tools/list call #2");

      // The cache serves the fresh records, not the stale first read.
      expect(
        cache
          .searchCapabilities("refresh_probe")
          .map((record) => (record.kind === "tool" ? record.description : "")),
      ).toEqual(["tools/list call #2"]);
    });
  });
});

describe("capability cache snapshot (D-009 freshness without transports)", () => {
  it("exposes freshness and counts as plain data", async () => {
    await withCache([stdioConfig("alpha"), stdioConfig("big", "large")], async (cache) => {
      // Before any discovery: both servers listed, nothing discovered, no transport touched.
      expect(cache.snapshot()).toEqual([
        { server: "alpha", discovered: false, counts: { tools: 0, resources: 0, prompts: 0 } },
        { server: "big", discovered: false, counts: { tools: 0, resources: 0, prompts: 0 } },
      ]);

      const before = Date.now();
      await cache.refreshCapabilities("big");
      const snapshot = cache.snapshot();

      expect(snapshot[0]).toEqual({
        server: "alpha",
        discovered: false,
        counts: { tools: 0, resources: 0, prompts: 0 },
      });
      expect(snapshot[1]).toMatchObject({
        server: "big",
        discovered: true,
        counts: { tools: LARGE_CATALOG_SIZE, resources: 2, prompts: 2 },
      });
      expect(snapshot[1]?.discoveredAt).toBeGreaterThanOrEqual(before);

      // Plain serializable data: safe for /doctor, no functions or transport handles inside.
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    });
  });
});
