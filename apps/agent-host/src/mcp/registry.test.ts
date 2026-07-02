import { describe, expect, test } from "vitest";
import { normalizeMcpServersConfig } from "./config";
import { createMcpRegistry } from "./registry";

const servers = normalizeMcpServersConfig({
  servers: {
    "tool-proxy": { transport: "http", endpoint: "http://127.0.0.1:4700/mcp" },
    github: { transport: "stdio", command: "github-mcp" },
    docs: { transport: "http", endpoint: "http://127.0.0.1:9999/mcp", enabled: false },
  },
}).servers;

describe("createMcpRegistry", () => {
  test("list() returns every configured server in config order", () => {
    const registry = createMcpRegistry(servers);
    expect(registry.list().map((server) => server.name)).toEqual(["tool-proxy", "github", "docs"]);
  });

  test("enabled() filters out disabled servers", () => {
    const registry = createMcpRegistry(servers);
    expect(registry.enabled().map((server) => server.name)).toEqual(["tool-proxy", "github"]);
  });

  test("get() resolves a server by exact name and returns undefined for unknown names", () => {
    const registry = createMcpRegistry(servers);
    expect(registry.get("github")?.transport).toBe("stdio");
    expect(registry.get("GITHUB")).toBeUndefined();
    expect(registry.get("nope")).toBeUndefined();
  });

  test("tool-proxy resolves through the same lookup path as any other named server (D-001)", () => {
    const registry = createMcpRegistry(servers);
    const proxy = registry.get("tool-proxy");
    expect(proxy?.transport).toBe("http");
    expect(registry.enabled()).toContain(proxy);
  });

  test("an empty registry lists nothing and resolves nothing", () => {
    const registry = createMcpRegistry([]);
    expect(registry.list()).toEqual([]);
    expect(registry.enabled()).toEqual([]);
    expect(registry.get("tool-proxy")).toBeUndefined();
  });
});
