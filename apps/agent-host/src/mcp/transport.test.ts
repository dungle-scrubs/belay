import { describe, expect, test, vi } from "vitest";
import { armRequestTimeout, decodeInitializeResult, MCP_PROTOCOL_VERSION } from "./transport";

describe("decodeInitializeResult (shared handshake decoding)", () => {
  test("accepts a supported protocol version and carries capabilities + serverInfo", () => {
    const outcome = decodeInitializeResult("srv", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "0.0.1" },
    });
    expect(outcome).toEqual({
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "0.0.1" },
      },
    });
  });

  test("omits serverInfo when the server sent none", () => {
    const outcome = decodeInitializeResult("srv", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
    });
    expect(outcome).toEqual({
      result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
    });
  });

  test("rejects an unsupported protocol version as a handshake failure", () => {
    const outcome = decodeInitializeResult("srv", {
      protocolVersion: "1999-01-01",
      capabilities: {},
    });
    expect(outcome).toMatchObject({
      failure: { _tag: "McpHandshakeError", server: "srv" },
    });
    if ("failure" in outcome) {
      expect(outcome.failure.message).toContain("1999-01-01");
    }
  });

  test("rejects a result without a protocolVersion", () => {
    expect(decodeInitializeResult("srv", { capabilities: {} })).toMatchObject({
      failure: { _tag: "McpHandshakeError" },
    });
  });

  test("rejects a non-object result", () => {
    expect(decodeInitializeResult("srv", "nope")).toMatchObject({
      failure: { _tag: "McpHandshakeError" },
    });
  });
});

describe("armRequestTimeout (shared per-request deadline)", () => {
  test("fires the typed timeout error once the deadline passes", () => {
    vi.useFakeTimers();
    try {
      const seen: unknown[] = [];
      armRequestTimeout("srv", "tools/list", 250, (error) => seen.push(error));
      vi.advanceTimersByTime(249);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen).toMatchObject([
        { _tag: "McpTimeoutError", server: "srv", method: "tools/list", timeoutMs: 250 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the disposer cancels the deadline", () => {
    vi.useFakeTimers();
    try {
      const seen: unknown[] = [];
      const disarm = armRequestTimeout("srv", "tools/list", 250, (error) => seen.push(error));
      disarm();
      vi.advanceTimersByTime(1_000);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
