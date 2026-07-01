import {
  isRetryableFailure,
  type SandboxMode,
  type ToolScriptArtifact,
  type ToolScriptBridgeCall,
  type ToolScriptBudgets,
  type ToolScriptFailureClass,
  type ToolScriptResult,
} from "@trevor/session";
import { shortSha16 } from "./hash";
import { resultWithinBudget, summarizeToolOutput } from "./output-budget";
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

/** Hashes a bridge-call input to a short, content-free correlator (never carries the raw args). */
function shortHash(input: unknown): string {
  return shortSha16(JSON.stringify(input) ?? "");
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
  const artifacts: ToolScriptArtifact[] = [];
  let outputBytes = 0;
  let settled = false;
  // Slots RESERVED synchronously at request entry (counts in-flight calls too). The budget must gate on
  // this, not on `bridgeCalls.length` - which only grows AFTER each `await`, so a script that fires many
  // bridge_requests concurrently would otherwise slip every one of them past a length check.
  let reservedBridgeCalls = 0;

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
    // Final-output bound: a script cannot return an unbounded blob into the transcript/context.
    if (!resultWithinBudget(scriptResult, options.budgets.maxResultBytes)) {
      finishFail("output_too_large", `result exceeds ${options.budgets.maxResultBytes} bytes`);
      return;
    }
    settle({
      status: "completed",
      result: scriptResult,
      bridgeCalls,
      artifacts,
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
      artifacts,
      counters: counters(),
      sandboxMode: options.sandboxMode,
    });
  }

  async function handleBridgeRequest(callId: number, tool: string, input: unknown): Promise<void> {
    // The run may have already settled (timeout/cancel/crash) while this request was queued: do no work.
    if (settled) {
      return;
    }
    const callStart = now();
    // Hard stop for a runaway script (no hidden autonomy): past the budget, deny + fail the run. Gate on
    // the reserved count so concurrently-issued requests cannot collectively overrun the budget.
    if (reservedBridgeCalls >= options.budgets.maxBridgeCalls) {
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
    // Reserve the slot BEFORE awaiting, so a burst of concurrent requests is bounded by the budget.
    reservedBridgeCalls += 1;
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
    // A large tool output is summarized to a bounded artifact ref before the script (or transcript) sees it.
    const summarized = response.output
      ? summarizeToolOutput(response.output, options.budgets.maxToolOutputBytes)
      : { output: undefined, artifact: undefined };
    if (summarized.artifact) {
      artifacts.push(summarized.artifact);
    }
    const bytes = summarized.output ? Buffer.byteLength(summarized.output) : 0;
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
      ...(summarized.output !== undefined ? { output: summarized.output } : {}),
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
