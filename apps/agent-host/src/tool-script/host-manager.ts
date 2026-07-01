import { createHash } from "node:crypto";
import {
  isRetryableFailure,
  type SandboxMode,
  type ToolScriptBridgeCall,
  type ToolScriptBudgets,
  type ToolScriptFailureClass,
  type ToolScriptResult,
} from "@trevor/session";
import type { HostToRunner, RunnerContext, RunnerToHost } from "./protocol";

/**
 * The `tool_script` HOST-side run manager (plan 16, M3): it drives ONE child runner through the protocol -
 * sends `execute` after the child's `start`, answers each `bridge_request` by routing to the host tool
 * bridge, and settles a single {@link ToolScriptResult} on `complete`/`fail`/timeout/cancel/child-crash. It
 * is factored over injected `ManagedChild` + `ToolScriptBridge` so the whole lifecycle is unit-tested
 * without spawning; the real spawn wiring is a thin adapter around it.
 *
 * The manager is the authoritative control plane: every bridge call is counted (a runaway script is stopped
 * at the max-bridge-calls budget), a timeout/cancel KILLS the child (the hard stop for a synchronous loop),
 * and a child that dies early resolves as a failure rather than hanging the turn.
 */

/** The child process, abstracted for testability (stdin write / stdout messages / exit / kill). */
export interface ManagedChild {
  send(message: HostToRunner): void;
  onMessage(cb: (message: RunnerToHost) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

/** Routes one bridge call to the host tool registry, returning the tool output or a denied/failed status. */
export interface ToolScriptBridge {
  call(
    tool: string,
    input: unknown,
  ): Promise<{
    readonly status: "ok" | "denied" | "failed";
    readonly output?: string;
    readonly error?: string;
  }>;
}

export interface RunOptions {
  readonly script: string;
  readonly context: RunnerContext;
  readonly budgets: ToolScriptBudgets;
  readonly sandboxMode: SandboxMode;
  /** Injectable timer (tests); defaults to setTimeout. Returns a canceller. */
  readonly setTimer?: (ms: number, cb: () => void) => () => void;
  /** Injectable clock (tests); defaults to Date.now. */
  readonly now?: () => number;
}

export interface RunHandle {
  readonly result: Promise<ToolScriptResult>;
  cancel(): void;
}

const defaultTimer = (ms: number, cb: () => void): (() => void) => {
  const t = setTimeout(cb, ms);
  return () => clearTimeout(t);
};

function shortHash(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input) ?? "")
    .digest("hex")
    .slice(0, 16);
}

/** Drives one child runner to a single result. */
export function manageToolScriptRun(
  child: ManagedChild,
  bridge: ToolScriptBridge,
  options: RunOptions,
): RunHandle {
  const setTimer = options.setTimer ?? defaultTimer;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const bridgeCalls: ToolScriptBridgeCall[] = [];
  let outputBytes = 0;
  let settled = false;

  let resolve!: (result: ToolScriptResult) => void;
  const result = new Promise<ToolScriptResult>((r) => {
    resolve = r;
  });

  const cancelTimeout = setTimer(options.budgets.timeoutMs, () =>
    finishFail("timeout", "script timed out"),
  );

  const counters = () => ({
    bridgeCalls: bridgeCalls.length,
    outputBytes,
    durationMs: now() - startedAt,
  });

  function settle(result: ToolScriptResult): void {
    if (settled) {
      return;
    }
    settled = true;
    cancelTimeout();
    child.kill();
    resolve(result);
  }

  function finishComplete(scriptResult: unknown): void {
    settle({
      status: "completed",
      result: scriptResult,
      bridgeCalls,
      counters: counters(),
      sandboxMode: options.sandboxMode,
    });
  }

  function finishFail(failureClass: ToolScriptFailureClass, error: string): void {
    settle({
      status: "failed",
      failureClass,
      retryable: isRetryableFailure(failureClass),
      error,
      bridgeCalls,
      counters: counters(),
      sandboxMode: options.sandboxMode,
    });
  }

  async function handleBridgeRequest(callId: number, tool: string, input: unknown): Promise<void> {
    const callStart = now();
    // Hard stop for a runaway script (no hidden autonomy): past the budget, deny + fail the run.
    if (bridgeCalls.length >= options.budgets.maxBridgeCalls) {
      child.send({
        type: "bridge_response",
        callId,
        status: "denied",
        error: "max bridge calls reached",
      });
      bridgeCalls.push({
        tool,
        inputHash: shortHash(input),
        outputBytes: 0,
        status: "denied",
        failureClass: "budget_exhausted",
      });
      finishFail("budget_exhausted", `exceeded ${options.budgets.maxBridgeCalls} bridge calls`);
      return;
    }
    let response: Awaited<ReturnType<ToolScriptBridge["call"]>>;
    try {
      response = await bridge.call(tool, input);
    } catch (error) {
      response = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (settled) {
      return;
    }
    const bytes = response.output ? Buffer.byteLength(response.output) : 0;
    outputBytes += bytes;
    bridgeCalls.push({
      tool,
      inputHash: shortHash(input),
      outputBytes: bytes,
      status: response.status,
      durationMs: now() - callStart,
      ...(response.status !== "ok"
        ? { failureClass: response.status === "denied" ? "bridge_denied" : "bridge_failed" }
        : {}),
    });
    child.send({
      type: "bridge_response",
      callId,
      status: response.status,
      ...(response.output !== undefined ? { output: response.output } : {}),
      ...(response.error !== undefined ? { error: response.error } : {}),
    });
  }

  child.onMessage((message) => {
    switch (message.type) {
      case "start":
        child.send({ type: "execute", script: options.script, context: options.context });
        break;
      case "bridge_request":
        void handleBridgeRequest(message.callId, message.tool, message.input);
        break;
      case "complete":
        finishComplete(message.result);
        break;
      case "fail":
        finishFail(message.failureClass, message.error);
        break;
    }
  });

  // A child that exits before completing/failing is a crash - resolve rather than hang the turn.
  child.onExit(() => finishFail("runtime_error", "child runner exited before completing"));

  return {
    result,
    cancel() {
      child.send({ type: "cancel" });
      finishFail("cancelled", "run cancelled");
    },
  };
}
