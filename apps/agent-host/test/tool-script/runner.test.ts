import { DEFAULT_TOOL_SCRIPT_BUDGETS, type ToolScriptResult } from "@trevor/session";
import { describe, expect, it } from "vitest";
import { manageToolScriptRun, type ToolScriptBridge } from "../../src/tool-script/host-manager";
import { defaultRunnerCommand, spawnRunner } from "../../src/tool-script/spawn";

/**
 * End-to-end M3: spawns the REAL child runner and drives it through the host manager over the actual
 * stdio protocol. Proves the process boundary works (script runs out-of-process), ambient globals are
 * absent in the child, the bridge round-trips, and a child crash is contained - not a host hang.
 */

function runReal(
  script: string,
  bridge: ToolScriptBridge = { call: () => Promise.resolve({ status: "ok", output: "file body" }) },
): Promise<ToolScriptResult> {
  const child = spawnRunner({ command: defaultRunnerCommand(), cwd: process.cwd() });
  const handle = manageToolScriptRun(child, bridge, {
    script,
    context: { cwd: process.cwd(), runId: "it" },
    budgets: DEFAULT_TOOL_SCRIPT_BUDGETS,
    sandboxMode: "child-process",
  });
  return handle.result;
}

describe("tool_script real child-runner integration (M3)", () => {
  it("runs a script OUT OF PROCESS and completes with its result", async () => {
    const result = await runReal("return 6 * 7;");
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result).toBe(42);
    }
  });

  it("round-trips a bridge call through the real protocol", async () => {
    const result = await runReal("const a = await tools.read({ path: 'x' }); return a.length;");
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result).toBe("file body".length);
    }
    expect(result.bridgeCalls[0]).toMatchObject({ tool: "read", status: "ok" });
  });

  it("denies ambient authority: process/require/fetch are undefined in the child", async () => {
    const result = await runReal(
      "return { p: typeof process, r: typeof require, f: typeof fetch };",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result).toEqual({ p: "undefined", r: "undefined", f: "undefined" });
    }
  });

  it("reports a runtime throw from the real child as a failed result", async () => {
    const result = await runReal("throw new Error('kaboom');");
    expect(result.status === "failed" && result.failureClass).toBe("runtime_error");
  });
}, 30_000);
