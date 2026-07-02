import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverCapabilities } from "../../src/mcp/capabilities";
import type { McpHttpServerConfig, McpStdioServerConfig } from "../../src/mcp/config";
import { createHttpTransport } from "../../src/mcp/http-transport";
import { spawnStdioTransport } from "../../src/mcp/stdio-transport";
import type { McpTransport } from "../../src/mcp/transport";
import { LARGE_CATALOG_SIZE } from "./fixture-catalog";
import { startFixtureHttpServer } from "./fixture-http-server";

/**
 * Capability discovery integration (plan 23 M4): discovers tools/resources/prompts from REAL
 * fixture servers - qualified identity with server provenance (D-005), exposure-flag
 * filtering (D-002), paginated large catalogs, and duplicate simple names across two servers
 * on two different transports.
 */

const FIXTURE = join(import.meta.dirname, "fixture-server.ts");

function stdioConfig(
  name: string,
  overrides: Partial<McpStdioServerConfig> = {},
): McpStdioServerConfig {
  return {
    name,
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", FIXTURE],
    env: {},
    exposure: { tools: true, resources: true, prompts: true },
    requestTimeoutMs: 10_000,
    ...overrides,
  };
}

async function withStdioTransport(
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

describe("capability discovery over a real stdio server", () => {
  it("discovers qualified tool/resource/prompt records with provenance and schemas", async () => {
    await withStdioTransport(stdioConfig("alpha"), async (transport) => {
      const discovered = await discoverCapabilities(
        { name: "alpha", exposure: { tools: true, resources: true, prompts: true } },
        transport,
      );

      expect(discovered.server).toBe("alpha");
      expect(discovered.tools.map((tool) => tool.qualifiedName)).toEqual([
        "alpha:echo",
        "alpha:env_probe",
      ]);
      expect(discovered.tools[0]).toMatchObject({
        kind: "tool",
        server: "alpha",
        name: "echo",
        description: "echoes text back",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      });
      expect(discovered.resources).toMatchObject([
        {
          kind: "resource",
          server: "alpha",
          qualifiedName: "alpha:readme",
          uri: "fixture://readme",
          mimeType: "text/plain",
        },
        { qualifiedName: "alpha:daily_log" },
      ]);
      expect(discovered.prompts).toMatchObject([
        {
          kind: "prompt",
          server: "alpha",
          qualifiedName: "alpha:summarize",
          description: "summarize the given text",
          arguments: [{ name: "text", required: true }],
        },
        { qualifiedName: "alpha:greet" },
      ]);
    });
  });

  it("honors exposure flags: a switched-off family is not discovered (D-002)", async () => {
    await withStdioTransport(stdioConfig("alpha"), async (transport) => {
      const discovered = await discoverCapabilities(
        { name: "alpha", exposure: { tools: true, resources: false, prompts: false } },
        transport,
      );
      expect(discovered.tools.length).toBeGreaterThan(0);
      expect(discovered.resources).toEqual([]);
      expect(discovered.prompts).toEqual([]);
    });
  });

  it("follows pagination to discover the full large catalog", async () => {
    const config = stdioConfig("big");
    await withStdioTransport(
      stdioConfig("big", { args: [...config.args, "--catalog=large"] }),
      async (transport) => {
        const discovered = await discoverCapabilities(
          { name: "big", exposure: { tools: true, resources: true, prompts: true } },
          transport,
        );
        expect(discovered.tools).toHaveLength(LARGE_CATALOG_SIZE);
      },
    );
  });
});

describe("capability discovery across two servers (D-005 duplicate names)", () => {
  it("keeps same-named tools from different servers apart via qualified identity", async () => {
    const fixture = await startFixtureHttpServer();
    const httpConfig: McpHttpServerConfig = {
      name: "beta",
      enabled: true,
      transport: "http",
      endpoint: fixture.endpoint,
      exposure: { tools: true, resources: true, prompts: true },
      requestTimeoutMs: 10_000,
    };
    const httpTransport = createHttpTransport(httpConfig);
    try {
      await withStdioTransport(stdioConfig("alpha"), async (stdioTransport) => {
        const [alpha, beta] = await Promise.all([
          discoverCapabilities({ name: "alpha", exposure: httpConfig.exposure }, stdioTransport),
          discoverCapabilities({ name: "beta", exposure: httpConfig.exposure }, httpTransport),
        ]);

        const alphaEcho = alpha.tools.find((tool) => tool.name === "echo");
        const betaEcho = beta.tools.find((tool) => tool.name === "echo");
        expect(alphaEcho).toMatchObject({ server: "alpha", qualifiedName: "alpha:echo" });
        expect(betaEcho).toMatchObject({ server: "beta", qualifiedName: "beta:echo" });
        expect(alphaEcho?.qualifiedName).not.toBe(betaEcho?.qualifiedName);
      });
    } finally {
      await httpTransport.close();
      await fixture.close();
    }
  });
});
