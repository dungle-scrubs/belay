import { describe, expect, it } from "vitest";
import {
  createLineReader,
  decodeHostToRunner,
  decodeRunnerToHost,
  encodeMessage,
  type HostToRunner,
  RUNNER_PROTOCOL_VERSION,
  type RunnerToHost,
} from "./protocol";

describe("tool_script runner protocol codec (M3)", () => {
  it("round-trips every child->host message through encode + decode", () => {
    const messages: RunnerToHost[] = [
      { type: "start", protocol: RUNNER_PROTOCOL_VERSION },
      { type: "bridge_request", callId: 1, tool: "read", input: { path: "a.ts" } },
      { type: "complete", result: { files: 2 } },
      { type: "fail", failureClass: "runtime_error", error: "boom" },
    ];
    for (const msg of messages) {
      const line = encodeMessage(msg);
      expect(line.endsWith("\n")).toBe(true);
      expect(decodeRunnerToHost(line.trim())).toEqual(msg);
    }
  });

  it("round-trips every host->child message", () => {
    const messages: HostToRunner[] = [
      { type: "execute", script: "return 1;", context: { cwd: "/w", runId: "r1" } },
      { type: "bridge_response", callId: 1, status: "ok", output: "file contents" },
      { type: "bridge_response", callId: 2, status: "denied", error: "toolset not permitted" },
      { type: "cancel" },
    ];
    for (const msg of messages) {
      expect(decodeHostToRunner(encodeMessage(msg).trim())).toEqual(msg);
    }
  });

  it("decodes a malformed / unknown line to null instead of throwing (crash containment)", () => {
    for (const bad of ["", "   ", "not json", "{", '{"type":"bogus"}', "[]", "42"]) {
      expect(decodeRunnerToHost(bad)).toBeNull();
      expect(decodeHostToRunner(bad)).toBeNull();
    }
    // A bridge_request missing its required fields is rejected, not half-decoded.
    expect(decodeRunnerToHost('{"type":"bridge_request","tool":"read"}')).toBeNull();
  });

  it("normalizes an unknown failureClass on a fail message to runtime_error", () => {
    expect(decodeRunnerToHost('{"type":"fail","failureClass":"wat","error":"x"}')).toEqual({
      type: "fail",
      failureClass: "runtime_error",
      error: "x",
    });
  });
});

describe("tool_script line reader - chunk tolerance + buffer cap (M3)", () => {
  it("reassembles messages split across chunk boundaries", () => {
    const reader = createLineReader({ maxLineBytes: 1000 });
    expect(reader.push('{"a":1}\n{"b')).toEqual(['{"a":1}']);
    expect(reader.push('":2}\n')).toEqual(['{"b":2}']);
    expect(reader.buffered()).toBe(0);
  });

  it("emits multiple complete lines from one chunk", () => {
    const reader = createLineReader({ maxLineBytes: 1000 });
    expect(reader.push("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });

  it("DROPS an un-terminated line that exceeds the byte cap (spam containment)", () => {
    const reader = createLineReader({ maxLineBytes: 16 });
    // No newline, grows past the cap -> buffer is discarded, host memory bounded.
    expect(reader.push("x".repeat(64))).toEqual([]);
    expect(reader.buffered()).toBe(0);
    // The reader keeps working after a drop.
    expect(reader.push("recovered\n")).toEqual(["recovered"]);
  });
});
