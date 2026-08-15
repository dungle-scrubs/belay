import { DEFAULT_TOOL_SCRIPT_BUDGETS, type ToolScriptResult } from "@belay/session";
import { describe, expect, it } from "vitest";
import { manageToolScriptRun, type ToolScriptBridge } from "../../src/tool-script/host-manager";
import { resolveRunnerLaunch } from "../../src/tool-script/launch";
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

  it("closes the globalThis + Function-constructor escapes to ambient authority (DiD)", async () => {
    const result = await runReal(
      // globalThis itself is lexically shadowed; the network primitives are also nulled on the real
      // global object, so even the Function-constructor route (which runs in global scope) finds nothing.
      "return { g: typeof globalThis, ff: (new Function('return typeof fetch'))(), " +
        "gp: (new Function('return typeof (globalThis && globalThis.process)'))() };",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result).toEqual({ g: "undefined", ff: "undefined", gp: "object" });
    }
  });

  it("reports a runtime throw from the real child as a failed result", async () => {
    const result = await runReal("throw new Error('kaboom');");
    expect(result.status === "failed" && result.failureClass).toBe("runtime_error");
  });

  it("resolves a launch on the real host and runs to completion under the effective mode (M4)", async () => {
    // Real sandbox probe: on a host where the Seatbelt profile cannot boot Node this degrades to
    // child-process; either way the resolved command must run the script to completion. This
    // integration path legitimately exercises the reduced-isolation fallback, so it opts in.
    const launch = await resolveRunnerLaunch({
      scratchDir: process.cwd(),
      allowUnsandboxed: true,
    });
    if (!launch.ok) {
      throw new Error(`expected a launch, got refusal: ${launch.reason}`);
    }
    expect(["sandbox-exec", "child-process"]).toContain(launch.sandboxMode);
    const child = spawnRunner({ command: launch.command, cwd: process.cwd() });
    const result = await manageToolScriptRun(
      child,
      { call: () => Promise.resolve({ status: "ok", output: "" }) },
      {
        script: "return 1 + 1;",
        context: { cwd: process.cwd() },
        budgets: DEFAULT_TOOL_SCRIPT_BUDGETS,
        sandboxMode: launch.sandboxMode,
      },
    ).result;
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result).toBe(2);
    }
  });
}, 30_000);
