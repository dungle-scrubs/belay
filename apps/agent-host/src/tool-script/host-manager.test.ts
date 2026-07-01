import { DEFAULT_TOOL_SCRIPT_BUDGETS } from "@trevor/session";
import { describe, expect, it } from "vitest";
import { type ManagedChild, manageToolScriptRun, type ToolScriptBridge } from "./host-manager";
import type { HostToRunner, RunnerToHost } from "./protocol";

/** A fake child the test drives: it records what the host sent and lets the test emit runner messages. */
class FakeChild implements ManagedChild {
  readonly sent: HostToRunner[] = [];
  private onMsg: ((m: RunnerToHost) => void) | null = null;
  private onExitCb: (() => void) | null = null;
  killed = false;
  send(m: HostToRunner) {
    this.sent.push(m);
  }
  onMessage(cb: (m: RunnerToHost) => void) {
    this.onMsg = cb;
  }
  onExit(cb: () => void) {
    this.onExitCb = cb;
  }
  kill() {
    this.killed = true;
  }
  emit(m: RunnerToHost) {
    this.onMsg?.(m);
  }
  exit() {
    this.onExitCb?.();
  }
}

const OPTS = {
  script: "return 1;",
  context: { cwd: "/w" },
  budgets: DEFAULT_TOOL_SCRIPT_BUDGETS,
  sandboxMode: "child-process" as const,
  // Never fires on its own; the test triggers timeout explicitly where needed.
  setTimer: () => () => {},
};

function bridge(
  answer: (tool: string) => Awaited<ReturnType<ToolScriptBridge["call"]>>,
): ToolScriptBridge {
  return { call: (tool) => Promise.resolve(answer(tool)) };
}

describe("tool_script host manager lifecycle (M3)", () => {
  it("sends execute after the child's start, routes bridge calls, and returns a completed result", async () => {
    const child = new FakeChild();
    const handle = manageToolScriptRun(
      child,
      bridge(() => ({ status: "ok", output: "file body" })),
      OPTS,
    );
    child.emit({ type: "start", protocol: 1 });
    expect(child.sent[0]?.type).toBe("execute");
    child.emit({ type: "bridge_request", callId: 1, tool: "read", input: { path: "a" } });
    // Let the async bridge round-trip settle.
    await new Promise((r) => setTimeout(r, 0));
    const response = child.sent.find((m) => m.type === "bridge_response");
    expect(response).toMatchObject({ type: "bridge_response", callId: 1, status: "ok" });
    child.emit({ type: "complete", result: { ok: true } });
    const result = await handle.result;
    expect(result.status).toBe("completed");
    expect(result.bridgeCalls[0]).toMatchObject({ tool: "read", status: "ok" });
    expect(result.counters.bridgeCalls).toBe(1);
    expect(result.sandboxMode).toBe("child-process");
  });

  it("returns a typed failed result when the child reports fail", async () => {
    const child = new FakeChild();
    const handle = manageToolScriptRun(
      child,
      bridge(() => ({ status: "ok" })),
      OPTS,
    );
    child.emit({ type: "start", protocol: 1 });
    child.emit({ type: "fail", failureClass: "runtime_error", error: "boom" });
    const result = await handle.result;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureClass).toBe("runtime_error");
      expect(result.retryable).toBe(false);
    }
  });

  it("kills the child and returns a timeout result when the timer fires", async () => {
    const child = new FakeChild();
    let fire = () => {};
    const handle = manageToolScriptRun(
      child,
      bridge(() => ({ status: "ok" })),
      {
        ...OPTS,
        setTimer: (_ms, cb) => {
          fire = cb;
          return () => {};
        },
      },
    );
    child.emit({ type: "start", protocol: 1 });
    fire();
    const result = await handle.result;
    expect(child.killed).toBe(true);
    expect(result.status === "failed" && result.failureClass).toBe("timeout");
  });

  it("returns a cancelled result and kills the child on cancel()", async () => {
    const child = new FakeChild();
    const handle = manageToolScriptRun(
      child,
      bridge(() => ({ status: "ok" })),
      OPTS,
    );
    child.emit({ type: "start", protocol: 1 });
    handle.cancel();
    const result = await handle.result;
    expect(child.killed).toBe(true);
    expect(result.status === "failed" && result.failureClass).toBe("cancelled");
  });

  it("contains a child crash: an early exit becomes a failed result, not a hang", async () => {
    const child = new FakeChild();
    const handle = manageToolScriptRun(
      child,
      bridge(() => ({ status: "ok" })),
      OPTS,
    );
    child.emit({ type: "start", protocol: 1 });
    child.exit(); // child died before complete/fail
    const result = await handle.result;
    expect(result.status).toBe("failed");
  });

  it("stops a runaway script at the max-bridge-calls budget", async () => {
    const child = new FakeChild();
    const handle = manageToolScriptRun(
      child,
      bridge(() => ({ status: "ok", output: "x" })),
      {
        ...OPTS,
        budgets: { ...DEFAULT_TOOL_SCRIPT_BUDGETS, maxBridgeCalls: 2 },
      },
    );
    child.emit({ type: "start", protocol: 1 });
    for (let i = 1; i <= 3; i++) {
      child.emit({ type: "bridge_request", callId: i, tool: "read", input: {} });
      await new Promise((r) => setTimeout(r, 0));
    }
    const result = await handle.result;
    expect(result.status === "failed" && result.failureClass).toBe("budget_exhausted");
  });
});
