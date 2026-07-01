import { describe, expect, it } from "vitest";
import type { HostToRunner, RunnerToHost } from "./protocol";
import { createRunnerCore } from "./runner-core";

/** Drives the core with a scripted bridge: each bridge_request is answered by `answer(tool, input)`. */
async function run(
  script: string,
  answer: (
    tool: string,
    input: unknown,
  ) => { status: "ok" | "denied" | "failed"; output?: string; error?: string },
): Promise<RunnerToHost> {
  return new Promise((resolve) => {
    const sent: RunnerToHost[] = [];
    const core = createRunnerCore((msg) => {
      sent.push(msg);
      if (msg.type === "bridge_request") {
        const r = answer(msg.tool, msg.input);
        // Reply asynchronously, like a real host round-trip.
        queueMicrotask(() =>
          core.handle({ type: "bridge_response", callId: msg.callId, ...r } as HostToRunner),
        );
      }
      if (msg.type === "complete" || msg.type === "fail") {
        resolve(msg);
      }
    });
    core.handle({ type: "execute", script, context: { cwd: "/w", runId: "r1" } });
  });
}

describe("tool_script child runner core (M3)", () => {
  it("runs a script, routes tool calls through the bridge, and completes with the result", async () => {
    const result = await run(
      "const a = await tools.read({ path: 'a.ts' }); return { len: a.length };",
      (tool) => (tool === "read" ? { status: "ok", output: "hello" } : { status: "denied" }),
    );
    expect(result.type).toBe("complete");
    if (result.type === "complete") {
      expect(result.result).toEqual({ len: 5 });
    }
  });

  it("classifies a SYNTAX error before execution", async () => {
    const result = await run("this is not valid ((", () => ({ status: "ok", output: "" }));
    expect(result.type).toBe("fail");
    if (result.type === "fail") {
      expect(result.failureClass).toBe("syntax_error");
    }
  });

  it("classifies a runtime throw as runtime_error", async () => {
    const result = await run("throw new Error('boom');", () => ({ status: "ok", output: "" }));
    expect(result.type === "fail" && result.failureClass).toBe("runtime_error");
  });

  it("surfaces a DENIED bridge call as a bridge_denied failure", async () => {
    const result = await run("return await tools.bash({ cmd: 'ls' });", () => ({
      status: "denied",
      error: "bash not in toolset",
    }));
    expect(result.type === "fail" && result.failureClass).toBe("bridge_denied");
  });

  it("surfaces a FAILED bridge call as a bridge_failed failure", async () => {
    const result = await run("return await tools.read({ path: 'x' });", () => ({
      status: "failed",
      error: "no such file",
    }));
    expect(result.type === "fail" && result.failureClass).toBe("bridge_failed");
  });

  it("denies ambient globals (process/require/fetch are undefined in the script)", async () => {
    const result = await run(
      "return { hasProcess: typeof process, hasFetch: typeof fetch };",
      () => ({
        status: "ok",
        output: "",
      }),
    );
    expect(result.type).toBe("complete");
    if (result.type === "complete") {
      expect(result.result).toEqual({ hasProcess: "undefined", hasFetch: "undefined" });
    }
  });

  it("rejects in-flight bridge calls with a cancelled failure on cancel", async () => {
    const result = await new Promise<RunnerToHost>((resolve) => {
      const core = createRunnerCore((msg) => {
        if (msg.type === "bridge_request") {
          // Never answer; instead cancel while the call is pending.
          queueMicrotask(() => core.handle({ type: "cancel" }));
        }
        if (msg.type === "fail" || msg.type === "complete") {
          resolve(msg);
        }
      });
      core.handle({
        type: "execute",
        script: "return await tools.read({ path: 'slow' });",
        context: { cwd: "/w" },
      });
    });
    expect(result.type === "fail" && result.failureClass).toBe("cancelled");
  });
});
