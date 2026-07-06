import { describe, expect, test } from "vitest";
import { decodeInitializeResult, MCP_PROTOCOL_VERSION } from "./transport";

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
