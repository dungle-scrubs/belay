import { describe, expect, test } from "vitest";
import type { McpHttpServerConfig } from "./config";
import { buildHttpHeaders } from "./http-transport";

function httpConfig(overrides: Partial<McpHttpServerConfig> = {}): McpHttpServerConfig {
  return {
    name: "remote",
    enabled: true,
    transport: "http",
    endpoint: "https://mcp.example.test/mcp",
    exposure: { tools: true, resources: true, prompts: true },
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

describe("buildHttpHeaders (pure header assembly)", () => {
  test("always sends a JSON body and accepts both response shapes", () => {
    expect(buildHttpHeaders(httpConfig())).toEqual({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
  });

  test("carries bearer auth when configured", () => {
    const headers = buildHttpHeaders(httpConfig({ auth: { bearerToken: "tok-123" } }));
    expect(headers.authorization).toBe("Bearer tok-123");
  });

  test("omits authorization entirely without a bearer token", () => {
    expect(
      buildHttpHeaders(httpConfig({ auth: { oauth: { clientId: "cid" } } })),
    ).not.toHaveProperty("authorization");
  });

  test("echoes the session id and negotiated protocol version once known", () => {
    const headers = buildHttpHeaders(httpConfig(), {
      sessionId: "sess-1",
      protocolVersion: "2025-06-18",
    });
    expect(headers["mcp-session-id"]).toBe("sess-1");
    expect(headers["mcp-protocol-version"]).toBe("2025-06-18");
  });
});
