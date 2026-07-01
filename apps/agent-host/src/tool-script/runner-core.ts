import type { ToolScriptFailureClass } from "@trevor/session";
import type { HostToRunner, RunnerContext, RunnerToHost } from "./protocol";

/**
 * The `tool_script` child-runner CORE (plan 16, M3): the in-child logic that runs one script against the
 * bridge, factored OUT of the process/stdio wiring so it is unit-tested without spawning. It builds a
 * `tools` bridge (every call becomes a `bridge_request` the host answers), runs the script as an async
 * function with ambient globals (`process`/`Bun`/`require`/`fetch`) shadowed `undefined`, and ends with a
 * `complete` or a typed `fail`. It imports ONLY the protocol + the session contract - never the tool
 * registry (M3 REFACTOR) - so the process that runs user code carries no ambient Trevor authority.
 *
 * NOTE: the in-child global shadowing is defense-in-depth, NOT the safety boundary - the OS sandbox (M4)
 * and the host bridge policy (M5) are. A synchronous infinite loop cannot be interrupted from inside JS;
 * the host enforces the hard stop by killing the child on timeout/cancel.
 */

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

/** An error from a bridge call, carrying the failure class the host should report. */
class BridgeError extends Error {
  constructor(
    readonly failureClass: ToolScriptFailureClass,
    message: string,
  ) {
    super(message);
  }
}

export interface RunnerCore {
  /** Feed one incoming host message (execute / bridge_response / cancel). */
  handle(message: HostToRunner): void;
}

/** Creates the runner core over a `send` sink (the entry point wires `send` to stdout, `handle` to stdin). */
export function createRunnerCore(send: (message: RunnerToHost) => void): RunnerCore {
  let nextCallId = 1;
  let cancelled = false;
  const pending = new Map<
    number,
    { resolve: (output: string) => void; reject: (error: Error) => void }
  >();

  const rejectAllPending = (error: Error): void => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  /** One bridge call: send a request, resolve on `ok`, reject (typed) on denied/failed/cancel. */
  const callBridge = (tool: string, input: unknown): Promise<string> => {
    if (cancelled) {
      return Promise.reject(new BridgeError("cancelled", "cancelled"));
    }
    return new Promise<string>((resolve, reject) => {
      const callId = nextCallId++;
      pending.set(callId, { resolve, reject });
      send({ type: "bridge_request", callId, tool, input });
    });
  };

  const tools = new Proxy(
    {},
    {
      get: (_target, name) =>
        typeof name === "string" ? (input: unknown) => callBridge(name, input) : undefined,
    },
  );

  const classify = (error: unknown): ToolScriptFailureClass => {
    if (error instanceof BridgeError) {
      return error.failureClass;
    }
    return "runtime_error";
  };

  const execute = (script: string, context: RunnerContext): void => {
    let fn: (...args: unknown[]) => Promise<unknown>;
    try {
      // Build FIRST so a syntax error is reported distinctly, before any execution.
      fn = new AsyncFunction(
        "tools",
        "context",
        "process",
        "Bun",
        "require",
        "fetch",
        `"use strict";\n${script}`,
      );
    } catch (error) {
      send({ type: "fail", failureClass: "syntax_error", error: messageOf(error) });
      return;
    }
    // Ambient globals passed `undefined` (defense in depth): the script sees no process/require/fetch.
    fn(tools, context, undefined, undefined, undefined, undefined).then(
      (result) => {
        if (!cancelled) {
          send({ type: "complete", result });
        }
      },
      (error) => {
        send({ type: "fail", failureClass: classify(error), error: messageOf(error) });
      },
    );
  };

  return {
    handle(message) {
      switch (message.type) {
        case "execute":
          execute(message.script, message.context);
          break;
        case "bridge_response": {
          const entry = pending.get(message.callId);
          if (!entry) {
            return;
          }
          pending.delete(message.callId);
          if (message.status === "ok") {
            entry.resolve(message.output ?? "");
          } else {
            const failureClass: ToolScriptFailureClass =
              message.status === "denied" ? "bridge_denied" : "bridge_failed";
            entry.reject(new BridgeError(failureClass, message.error ?? message.status));
          }
          break;
        }
        case "cancel":
          cancelled = true;
          rejectAllPending(new BridgeError("cancelled", "cancelled"));
          break;
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
