import {
  type ToolScriptResult,
  type ToolScriptToolset,
  validateToolScriptRequest,
} from "@trevor/session";
import {
  SPAN_NAMES,
  safeAttributes,
  safeEmitSpan,
  type TelemetrySink,
} from "@trevor/session/telemetry";
import { Effect, Schema } from "effect";
import type { Tool, ToolContext } from "../tools/types";
import { type BridgeExecute, createToolScriptBridge } from "./bridge";
import { shortSha16 } from "./hash";
import { type ManagedChild, manageToolScriptRun } from "./host-manager";
import { type LaunchResolution, resolveRunnerLaunch } from "./launch";
import { toolScriptSink } from "./sink";
import { spawnRunner } from "./spawn";

/**
 * The model-facing `tool_script` tool (plan 16, M7). It is a NORMAL, visible, read-only tool - not a
 * workflow engine, subagent, or background job (D-001): one call runs one bounded script and returns one
 * result. It validates the request, resolves the launch mode (M4), spawns the isolated child runner (M3),
 * routes the script's calls through the toolset-gated bridge (M5) with budgets (M6), and formats the result
 * (or a typed failure) into the tool's string output. All the heavy pieces are injected, so the tool
 * unit-tests without the real registry and the real spawn.
 *
 * Responsible for: the model-facing tool_script tool - request validation, launch/spawn/bridge
 * wiring, span emission, and result formatting.
 * Not for: the run mechanics themselves - launch.ts / host-manager.ts / bridge.ts own those.
 */

export const TOOL_SCRIPT_DESCRIPTION =
  "Run a short, READ-ONLY TypeScript script for BOUNDED BATCH analysis across many inputs - e.g. scan " +
  "dozens of files with read/grep, or aggregate search results - returning one compact structured result. " +
  "The script gets an async `tools` bridge (safe_read: read, glob, grep, ast_grep) and a `context`; it has " +
  "NO filesystem, network, process, env, import, or shell access, and cannot write or mutate anything. Use " +
  "it ONLY for repeated read/search operations over many inputs; for a one-off read or search, call the " +
  "direct tool instead. It is bounded by a timeout, a max call count, and output caps.";

const Params = Schema.Struct({
  script: Schema.String.annotations({
    description:
      "The TypeScript script. `return` a compact result; `await tools.<name>(input)` to read.",
  }),
  toolsets: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => ["safe_read"],
  }).annotations({
    description: "Permitted capability toolsets. Default ['safe_read'] (read/glob/grep/ast_grep).",
  }),
});

export interface ToolScriptToolDeps {
  /** Runs a host tool by name (wired to the registry's executeTool at registration). */
  readonly execute: BridgeExecute;
  /** The workspace cwd handed to the script + the spawned child. */
  readonly cwd: string;
  /** Creates a fresh scratch dir the sandboxed child may write to; returns its path. */
  readonly makeScratchDir: () => string;
  /** Removes a scratch dir after the run (best-effort). */
  readonly cleanupScratchDir: (dir: string) => void;
  /** Telemetry sink for the observability span (default NOOP). */
  readonly sink?: TelemetrySink;
  /** Overridable for tests. */
  readonly resolveLaunch?: (scratchDir: string) => Promise<LaunchResolution>;
  readonly spawn?: (command: readonly string[], cwd: string) => ManagedChild;
}

/** Emits the `trevor.tool_script` observability span - script hash, sandbox mode, toolsets, bounded counts,
 *  and failure class. All attributes are low-cardinality + safeAttributes-gated (no script source, paths). */
function emitToolScriptSpan(
  sink: TelemetrySink,
  attrs: {
    readonly scriptHash: string;
    readonly toolsets: string;
    readonly sandboxMode: string;
    readonly bridgeCalls: number;
    readonly outputBytes: number;
    readonly artifacts: number;
    readonly durationMs: number;
    readonly ok: boolean;
    readonly failureClass?: string;
  },
): void {
  safeEmitSpan(sink, {
    name: SPAN_NAMES.toolScript,
    attributes: safeAttributes({
      script_hash: attrs.scriptHash,
      toolsets: attrs.toolsets,
      sandbox_mode: attrs.sandboxMode,
      bridge_calls: attrs.bridgeCalls,
      output_bytes: attrs.outputBytes,
      artifacts: attrs.artifacts,
      ...(attrs.failureClass ? { failure_class: attrs.failureClass } : {}),
    }),
    status: attrs.ok ? "ok" : "error",
    durationMs: attrs.durationMs,
  });
}

/** Formats a result into the tool's string output: the result for a success, a typed error line otherwise. */
export function formatToolScriptResult(result: ToolScriptResult): string {
  if (result.status === "completed") {
    if (typeof result.result === "string") {
      return result.result;
    }
    // `JSON.stringify` returns the value `undefined` (not a string) for an undefined/function/symbol
    // result; normalize that to "" so a `return;` script yields empty output, not the literal "undefined".
    return JSON.stringify(result.result) ?? "";
  }
  return `error: tool_script ${result.failureClass}: ${result.error}`;
}

async function runToolScript(
  args: typeof Params.Type,
  ctx: ToolContext | undefined,
  deps: ToolScriptToolDeps,
): Promise<string> {
  const sink = deps.sink ?? toolScriptSink();
  const scriptHash = shortSha16(args.script);
  const toolsets = args.toolsets.join(",");
  const validated = validateToolScriptRequest({
    language: "typescript",
    script: args.script,
    permissions: { toolsets: args.toolsets },
  });
  if (!validated.ok) {
    emitToolScriptSpan(sink, {
      scriptHash,
      toolsets,
      sandboxMode: "none",
      bridgeCalls: 0,
      outputBytes: 0,
      artifacts: 0,
      durationMs: 0,
      ok: false,
      failureClass: validated.failureClass,
    });
    return `error: tool_script ${validated.failureClass}: ${validated.error}`;
  }
  const request = validated.request;
  const scratchDir = deps.makeScratchDir();
  try {
    const launch = await (deps.resolveLaunch ?? ((s) => resolveRunnerLaunch({ scratchDir: s })))(
      scratchDir,
    );
    if (!launch.ok) {
      // Fail closed: no OS sandbox could confine the child, so the run is refused before any spawn (M4).
      emitToolScriptSpan(sink, {
        scriptHash,
        toolsets,
        sandboxMode: "none",
        bridgeCalls: 0,
        outputBytes: 0,
        artifacts: 0,
        durationMs: 0,
        ok: false,
        failureClass: "sandbox_launch",
      });
      return `error: tool_script sandbox_launch: ${launch.reason}`;
    }
    const spawn = deps.spawn ?? ((command, cwd) => spawnRunner({ command, cwd }));
    const child = spawn(launch.command, deps.cwd);
    const bridge = createToolScriptBridge({
      toolsets: request.permissions.toolsets as readonly ToolScriptToolset[],
      execute: deps.execute,
      ...(ctx?.runId !== undefined ? { runId: ctx.runId } : {}),
      ...(ctx?.callId !== undefined ? { callId: ctx.callId } : {}),
    });
    const result = await manageToolScriptRun(child, bridge, {
      script: request.script,
      context: {
        cwd: deps.cwd,
        ...(ctx?.runId !== undefined ? { runId: ctx.runId } : {}),
        ...(ctx?.callId !== undefined ? { toolCallId: ctx.callId } : {}),
      },
      budgets: request.budgets,
      sandboxMode: launch.sandboxMode,
    }).result;
    emitToolScriptSpan(sink, {
      scriptHash,
      toolsets,
      sandboxMode: result.sandboxMode,
      bridgeCalls: result.counters.bridgeCalls,
      outputBytes: result.counters.outputBytes,
      artifacts: result.artifacts.length,
      durationMs: result.counters.durationMs,
      ok: result.status === "completed",
      ...(result.status === "failed" ? { failureClass: result.failureClass } : {}),
    });
    return formatToolScriptResult(result);
  } catch (error) {
    emitToolScriptSpan(sink, {
      scriptHash,
      toolsets,
      sandboxMode: "none",
      bridgeCalls: 0,
      outputBytes: 0,
      artifacts: 0,
      durationMs: 0,
      ok: false,
      failureClass: "runtime_error",
    });
    return `error: tool_script runtime_error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    deps.cleanupScratchDir(scratchDir);
  }
}

/** Builds the `tool_script` tool. `execute` is wired to the host registry's `executeTool` at registration. */
export function buildToolScriptTool(deps: ToolScriptToolDeps): Tool<typeof Params.Type> {
  return {
    name: "tool_script",
    description: TOOL_SCRIPT_DESCRIPTION,
    params: Params,
    readOnly: true,
    execute: (args, ctx) => Effect.promise(() => runToolScript(args, ctx, deps)),
  };
}
