import { describe, expect, it } from "vitest";
import { allowedTools, type BridgeExecute, createToolScriptBridge } from "./bridge";

/** Records which tools were actually executed (to prove a denied tool never reaches the registry). */
function spyExecute(output = "tool output"): { execute: BridgeExecute; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    execute: (tool) => {
      calls.push(tool);
      return Promise.resolve(output);
    },
  };
}

describe("tool_script toolset capability matrix (M5)", () => {
  it("computes the allowed tool set as the union of the requested toolsets", () => {
    expect([...allowedTools(["safe_read"])].sort()).toEqual(["ast_grep", "glob", "grep", "read"]);
    expect(allowedTools(["retrieval"]).has("session_recall")).toBe(true);
    expect([...allowedTools(["safe_read", "retrieval"])]).toContain("read");
    expect([...allowedTools(["safe_read", "retrieval"])]).toContain("session_recall");
  });

  it("routes an ALLOWED tool call through the host execute and returns its output", async () => {
    const { execute, calls } = spyExecute("file body");
    const bridge = createToolScriptBridge({ toolsets: ["safe_read"], execute, runId: "r1" });
    const response = await bridge.call("read", { path: "a.ts" });
    expect(response).toEqual({ status: "ok", output: "file body" });
    expect(calls).toEqual(["read"]);
  });

  it("DENIES a tool that is not in any requested toolset - before it ever executes", async () => {
    const { execute, calls } = spyExecute();
    const bridge = createToolScriptBridge({ toolsets: ["safe_read"], execute });
    for (const tool of ["write", "edit", "bash", "process", "clipboard_write", "archive_unpack"]) {
      const response = await bridge.call(tool, {});
      expect(response.status).toBe("denied");
    }
    // Nothing disallowed reached the registry.
    expect(calls).toEqual([]);
  });

  it("DENIES a read-only tool that belongs to a DIFFERENT, un-requested toolset", async () => {
    const { execute, calls } = spyExecute();
    // Only safe_read requested; session_recall lives in `retrieval`.
    const bridge = createToolScriptBridge({ toolsets: ["safe_read"], execute });
    expect((await bridge.call("session_recall", { query: "x" })).status).toBe("denied");
    expect(calls).toEqual([]);
  });

  it("DENIES an unknown tool + tolerates an unknown toolset (no tools exposed)", async () => {
    const { execute } = spyExecute();
    expect(
      (await createToolScriptBridge({ toolsets: ["safe_read"], execute }).call("made_up", {}))
        .status,
    ).toBe("denied");
    // A toolset that is not known contributes no tools.
    // biome-ignore lint/suspicious/noExplicitAny: exercising a defensive path with a bad toolset.
    expect(allowedTools(["nope" as any]).size).toBe(0);
  });

  it("reports a host execute exception as a bridge failure (not a silent success)", async () => {
    const bridge = createToolScriptBridge({
      toolsets: ["safe_read"],
      execute: () => Promise.reject(new Error("registry blew up")),
    });
    const response = await bridge.call("read", { path: "a" });
    expect(response.status).toBe("failed");
    expect(response.error).toContain("registry blew up");
  });
});
