import { describe, expect, test, vi } from "vitest";
import {
  armRequestTimeout,
  decodeRpcError,
  type RpcErrorProps,
  type TimeoutErrorProps,
} from "./rpc";

// Local neutral error fixtures: the RPC toolkit is generic over each protocol's own error class, so its
// test supplies minimal stand-ins rather than reaching into mcp/ or lsp/ (which C-06 keeps it free of).
class FakeTimeoutError extends Error {
  readonly _tag = "FakeTimeoutError";
  readonly server: string;
  readonly method: string;
  readonly timeoutMs: number;
  constructor(props: TimeoutErrorProps) {
    super(`timeout ${props.method}`);
    this.server = props.server;
    this.method = props.method;
    this.timeoutMs = props.timeoutMs;
  }
}

class FakeRpcError extends Error {
  readonly _tag = "FakeRpcError";
  readonly server: string;
  readonly method: string;
  readonly code?: number;
  readonly detail: string;
  constructor(props: RpcErrorProps) {
    super(props.detail);
    this.server = props.server;
    this.method = props.method;
    this.code = props.code;
    this.detail = props.detail;
  }
}

describe("armRequestTimeout (shared per-request deadline)", () => {
  test("fires the injected timeout-error class once the deadline passes", () => {
    vi.useFakeTimers();
    try {
      const seen: FakeTimeoutError[] = [];
      armRequestTimeout("srv", "tools/list", 250, FakeTimeoutError, (error) => seen.push(error));
      vi.advanceTimersByTime(249);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen).toMatchObject([
        { _tag: "FakeTimeoutError", server: "srv", method: "tools/list", timeoutMs: 250 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the disposer cancels the deadline", () => {
    vi.useFakeTimers();
    try {
      const seen: FakeTimeoutError[] = [];
      const disarm = armRequestTimeout("srv", "tools/list", 250, FakeTimeoutError, (error) =>
        seen.push(error),
      );
      disarm();
      vi.advanceTimersByTime(1_000);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("decodeRpcError (shared tolerant rpc-error decoding)", () => {
  test("decodes code + message through the injected error class", () => {
    const error = decodeRpcError(
      "srv",
      "tools/call",
      { code: -32601, message: "nope" },
      FakeRpcError,
    );
    expect(error).toMatchObject({
      _tag: "FakeRpcError",
      server: "srv",
      method: "tools/call",
      code: -32601,
      detail: "nope",
    });
  });

  test("garbage error members fall back to the given detail, never a throw", () => {
    const error = decodeRpcError("srv", "tools/call", "not-an-object", FakeRpcError, "HTTP 500");
    expect(error).toMatchObject({ _tag: "FakeRpcError", detail: "HTTP 500" });
    expect(error.code).toBeUndefined();
  });
});
