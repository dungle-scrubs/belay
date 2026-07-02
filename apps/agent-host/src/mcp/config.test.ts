import { describe, expect, test } from "vitest";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  loadMcpServersConfig,
  type McpServerConfig,
  normalizeMcpServersConfig,
  redactMcpServerConfig,
} from "./config";

const stdioEntry = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "some-mcp-server"],
  env: { SOME_TOKEN: "s3cret" },
};

const httpEntry = {
  transport: "http",
  endpoint: "http://127.0.0.1:4700/mcp",
};

describe("normalizeMcpServersConfig - transports and required fields", () => {
  test("a stdio entry normalizes with command, args, and env", () => {
    const { servers, issues } = normalizeMcpServersConfig({ servers: { local: stdioEntry } });
    expect(issues).toEqual([]);
    expect(servers).toEqual([
      {
        name: "local",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp-server"],
        env: { SOME_TOKEN: "s3cret" },
        exposure: { tools: true, resources: true, prompts: true },
        requestTimeoutMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      },
    ]);
  });

  test("an http entry normalizes with endpoint and auth", () => {
    const { servers, issues } = normalizeMcpServersConfig({
      servers: {
        remote: {
          ...httpEntry,
          auth: { bearerToken: "tok-123", oauth: { clientId: "client-1" } },
        },
      },
    });
    expect(issues).toEqual([]);
    expect(servers).toEqual([
      {
        name: "remote",
        enabled: true,
        transport: "http",
        endpoint: "http://127.0.0.1:4700/mcp",
        auth: { bearerToken: "tok-123", oauth: { clientId: "client-1" } },
        exposure: { tools: true, resources: true, prompts: true },
        requestTimeoutMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      },
    ]);
  });

  test("a stdio entry without a command is dropped with a structured issue", () => {
    const { servers, issues } = normalizeMcpServersConfig({
      servers: { broken: { transport: "stdio" } },
    });
    expect(servers).toEqual([]);
    expect(issues).toEqual([
      { kind: "missing_command", server: "broken", detail: expect.stringContaining("command") },
    ]);
  });

  test("an http entry without a parseable http(s) endpoint is dropped with a structured issue", () => {
    const { servers, issues } = normalizeMcpServersConfig({
      servers: {
        missing: { transport: "http" },
        junk: { transport: "http", endpoint: "not a url" },
        wrongScheme: { transport: "http", endpoint: "ftp://example.com/mcp" },
      },
    });
    expect(servers).toEqual([]);
    expect(issues.map((issue) => [issue.kind, issue.server])).toEqual([
      ["invalid_endpoint", "missing"],
      ["invalid_endpoint", "junk"],
      ["invalid_endpoint", "wrongScheme"],
    ]);
  });

  test("an unknown transport is dropped with a structured issue", () => {
    const { servers, issues } = normalizeMcpServersConfig({
      servers: { weird: { transport: "carrier-pigeon" } },
    });
    expect(servers).toEqual([]);
    expect(issues).toEqual([
      {
        kind: "invalid_transport",
        server: "weird",
        detail: expect.stringContaining("carrier-pigeon"),
      },
    ]);
  });

  test("a non-object entry is dropped with a structured issue", () => {
    const { servers, issues } = normalizeMcpServersConfig({ servers: { nope: "yes please" } });
    expect(servers).toEqual([]);
    expect(issues).toEqual([{ kind: "invalid_shape", server: "nope", detail: expect.any(String) }]);
  });

  test("junk top-level shapes yield empty config without crashing", () => {
    expect(normalizeMcpServersConfig(undefined)).toEqual({ servers: [], issues: [] });
    expect(normalizeMcpServersConfig(null)).toEqual({ servers: [], issues: [] });
    expect(normalizeMcpServersConfig({})).toEqual({ servers: [], issues: [] });
    expect(normalizeMcpServersConfig({ servers: ["a"] }).issues).toEqual([
      { kind: "invalid_shape", server: "", detail: expect.stringContaining("servers") },
    ]);
  });
});

describe("normalizeMcpServersConfig - flags and knobs", () => {
  test("enabled: false is respected; a non-boolean enabled falls back to true", () => {
    const { servers } = normalizeMcpServersConfig({
      servers: {
        off: { ...httpEntry, enabled: false },
        on: { ...httpEntry, enabled: "sure" },
      },
    });
    expect(servers.map((server) => [server.name, server.enabled])).toEqual([
      ["off", false],
      ["on", true],
    ]);
  });

  test("exposure flags overlay the all-enabled default; junk values are ignored", () => {
    const { servers } = normalizeMcpServersConfig({
      servers: {
        partial: { ...httpEntry, exposure: { tools: false } },
        junk: { ...httpEntry, exposure: { tools: "no", resources: false } },
      },
    });
    expect(servers[0]?.exposure).toEqual({ tools: false, resources: true, prompts: true });
    expect(servers[1]?.exposure).toEqual({ tools: true, resources: false, prompts: true });
  });

  test("sampling is OFF unless the entry explicitly opts in with a boolean true", () => {
    const { servers } = normalizeMcpServersConfig({
      servers: {
        silent: httpEntry,
        opted: { ...httpEntry, sampling: true },
        explicit_off: { ...httpEntry, sampling: false },
        junk: { ...httpEntry, sampling: "yes" },
      },
    });
    expect(servers.map((server) => [server.name, server.sampling === true])).toEqual([
      ["silent", false],
      ["opted", true],
      ["explicit_off", false],
      ["junk", false],
    ]);
  });

  test("requestTimeoutMs accepts a positive integer and defaults anything else", () => {
    const { servers } = normalizeMcpServersConfig({
      servers: {
        fast: { ...httpEntry, requestTimeoutMs: 5_000 },
        junk: { ...httpEntry, requestTimeoutMs: "fast" },
        negative: { ...httpEntry, requestTimeoutMs: -5 },
      },
    });
    expect(servers.map((server) => server.requestTimeoutMs)).toEqual([
      5_000,
      DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    ]);
  });

  test("stdio env keeps only string values and args keeps only strings", () => {
    const { servers } = normalizeMcpServersConfig({
      servers: {
        local: {
          ...stdioEntry,
          args: ["ok", 7, null, "also-ok"],
          env: { GOOD: "yes", BAD: 42, WORSE: { nested: true } },
        },
      },
    });
    const server = servers[0];
    expect(server?.transport === "stdio" && server.args).toEqual(["ok", "also-ok"]);
    expect(server?.transport === "stdio" && server.env).toEqual({ GOOD: "yes" });
  });
});

describe("normalizeMcpServersConfig - names", () => {
  test("a name with a qualified-identity separator or whitespace is rejected", () => {
    const { servers, issues } = normalizeMcpServersConfig({
      servers: {
        "has:colon": httpEntry,
        "has space": httpEntry,
        "  ": httpEntry,
      },
    });
    expect(servers).toEqual([]);
    expect(issues.map((issue) => issue.kind)).toEqual([
      "invalid_name",
      "invalid_name",
      "invalid_name",
    ]);
  });

  test("duplicate names after trimming are rejected, first entry wins", () => {
    const { servers, issues } = normalizeMcpServersConfig({
      servers: {
        github: { ...httpEntry, endpoint: "http://one.example/mcp" },
        "github ": { ...httpEntry, endpoint: "http://two.example/mcp" },
      },
    });
    expect(servers.map((server) => server.name)).toEqual(["github"]);
    expect(servers[0]?.transport === "http" && servers[0].endpoint).toBe("http://one.example/mcp");
    expect(issues).toEqual([
      { kind: "duplicate_name", server: "github", detail: expect.any(String) },
    ]);
  });
});

describe("redactMcpServerConfig", () => {
  test("stdio env values are masked while keys, command, and args stay readable", () => {
    const { servers } = normalizeMcpServersConfig({ servers: { local: stdioEntry } });
    const server = servers[0] as McpServerConfig;
    expect(redactMcpServerConfig(server)).toEqual({
      name: "local",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-mcp-server"],
      env: { SOME_TOKEN: "[redacted]" },
      exposure: { tools: true, resources: true, prompts: true },
      requestTimeoutMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    });
  });

  test("http auth is masked and the endpoint keeps host + path but loses userinfo and query", () => {
    const { servers } = normalizeMcpServersConfig({
      servers: {
        remote: {
          transport: "http",
          endpoint: "https://user:pass@mcp.example.com:8443/v1/mcp?token=abc#frag",
          auth: { bearerToken: "tok-123", oauth: { clientId: "client-1" } },
        },
      },
    });
    const redacted = redactMcpServerConfig(servers[0] as McpServerConfig);
    expect(redacted.transport === "http" && redacted.endpoint).toBe(
      "https://mcp.example.com:8443/v1/mcp",
    );
    expect(redacted.transport === "http" && redacted.auth).toEqual({
      bearerToken: "[redacted]",
      oauth: { clientId: "client-1" },
    });
    expect(JSON.stringify(redacted)).not.toContain("tok-123");
    expect(JSON.stringify(redacted)).not.toContain("pass");
    expect(JSON.stringify(redacted)).not.toContain("token=abc");
  });

  test("an http server without auth redacts to a config without auth", () => {
    const { servers } = normalizeMcpServersConfig({ servers: { plain: httpEntry } });
    const redacted = redactMcpServerConfig(servers[0] as McpServerConfig);
    expect(redacted.transport === "http" && redacted.auth).toBeUndefined();
  });
});

describe("loadMcpServersConfig", () => {
  test("reads and normalizes the config file", () => {
    const config = loadMcpServersConfig(() => JSON.stringify({ servers: { local: stdioEntry } }));
    expect(config.servers.map((server) => server.name)).toEqual(["local"]);
  });

  test("a missing file yields empty config silently", () => {
    const config = loadMcpServersConfig(() => {
      throw new Error("ENOENT");
    });
    expect(config).toEqual({ servers: [], issues: [] });
  });

  test("a malformed file yields empty config instead of crashing", () => {
    const config = loadMcpServersConfig(() => "{ not json");
    expect(config).toEqual({ servers: [], issues: [] });
  });
});

describe("tool-proxy is an ordinary named server (D-001)", () => {
  test("a tool-proxy entry normalizes through the same path as any other http server", () => {
    const { servers, issues } = normalizeMcpServersConfig({
      servers: {
        "tool-proxy": { transport: "http", endpoint: "http://127.0.0.1:4700/mcp" },
        docs: { transport: "http", endpoint: "http://127.0.0.1:4700/mcp" },
      },
    });
    expect(issues).toEqual([]);
    const [proxy, docs] = servers;
    // Identical shape except the name: nothing about "tool-proxy" is special-cased.
    expect({ ...proxy, name: "x" }).toEqual({ ...docs, name: "x" });
  });
});
