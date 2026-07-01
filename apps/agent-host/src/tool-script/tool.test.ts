import type { ToolScriptResult } from "@trevor/session";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { buildToolScriptTool, formatToolScriptResult, type ToolScriptToolDeps } from "./tool";

const NOOP_DEPS: ToolScriptToolDeps = {
  execute: () => Promise.resolve(""),
  cwd: "/w",
  makeScratchDir: () => {
    throw new Error("scratch dir should not be created when validation rejects the request");
  },
  cleanupScratchDir: () => {},
};

const base = {
  bridgeCalls: [],
  artifacts: [],
  counters: { bridgeCalls: 0, outputBytes: 0, durationMs: 1 },
  sandboxMode: "child-process" as const,
};

describe("tool_script tool - metadata + validation (M7)", () => {
  it("is a read-only tool named tool_script whose description steers the model to batch use", () => {
    const tool = buildToolScriptTool(NOOP_DEPS);
    expect(tool.name).toBe("tool_script");
    expect(tool.readOnly).toBe(true);
    expect(tool.description.toLowerCase()).toContain("read-only");
    expect(tool.description.toLowerCase()).toMatch(/batch|many inputs|repeated/);
  });

  it("REJECTS an unsafe/unknown toolset before any child is spawned", async () => {
    const tool = buildToolScriptTool(NOOP_DEPS);
    const out = await Effect.runPromise(
      tool.execute({ script: "return 1;", toolsets: ["bash"] }, undefined),
    );
    // makeScratchDir throws if reached; a clean validation string proves it was not.
    expect(out).toContain("tool_script validation");
  });

  it("rejects an empty script as a validation failure", async () => {
    const tool = buildToolScriptTool(NOOP_DEPS);
    const out = await Effect.runPromise(
      tool.execute({ script: "   ", toolsets: ["safe_read"] }, undefined),
    );
    expect(out).toContain("tool_script validation");
  });
});

describe("tool_script result formatting (M7)", () => {
  it("returns the raw string result verbatim, and stringifies a structured result", () => {
    expect(formatToolScriptResult({ status: "completed", result: "hello", ...base })).toBe("hello");
    expect(formatToolScriptResult({ status: "completed", result: { n: 2 }, ...base })).toBe(
      '{"n":2}',
    );
  });

  it("formats a failure as a typed error line", () => {
    const failed: ToolScriptResult = {
      status: "failed",
      failureClass: "timeout",
      retryable: true,
      error: "timed out",
      ...base,
    };
    expect(formatToolScriptResult(failed)).toBe("error: tool_script timeout: timed out");
  });
});
