import { TOOLSET_TOOLS, type ToolScriptToolset } from "@trevor/session";
import type { ToolScriptBridge } from "./host-manager";

/**
 * The `tool_script` TOOLSET CAPABILITY bridge (plan 16, M5). It is the authoritative control plane the
 * plan's D-003 relies on: it gates every script call by the request's `permissions.toolsets` and routes an
 * ALLOWED read-only tool through the normal host tool registry (an injected `execute`, wired to
 * `executeTool` in M7), denying anything else BEFORE it can run. Write/edit/shell/process/clipboard/archive-
 * unpack/unknown tools are not in any toolset, so they are refused - the sandbox can grow by adding named
 * toolsets, never by opening ambient access.
 *
 * `execute` is injected (not imported) so this stays free of the heavy tool registry and unit-tests in
 * isolation; the host wires the real registry at registration time.
 */

/** Runs one host tool by name with JSON-encoded args, returning its (string) output. */
export type BridgeExecute = (
  tool: string,
  argsJson: string,
  runId?: string,
  callId?: string,
) => Promise<string>;

/** The set of tool names a set of toolsets exposes (the union of their tools; unknown toolsets add none). */
export function allowedTools(toolsets: readonly ToolScriptToolset[]): Set<string> {
  const allowed = new Set<string>();
  for (const toolset of toolsets) {
    for (const tool of TOOLSET_TOOLS[toolset] ?? []) {
      allowed.add(tool);
    }
  }
  return allowed;
}

export interface ToolScriptBridgeOptions {
  readonly toolsets: readonly ToolScriptToolset[];
  readonly execute: BridgeExecute;
  readonly runId?: string;
  readonly callId?: string;
}

/**
 * Builds a {@link ToolScriptBridge} for one run: a call to a tool in the permitted set routes through
 * `execute` (`ok` with its output, or `failed` if the registry throws); any other tool is `denied` without
 * executing.
 */
export function createToolScriptBridge(options: ToolScriptBridgeOptions): ToolScriptBridge {
  const allowed = allowedTools(options.toolsets);
  return {
    async call(tool, input) {
      if (!allowed.has(tool)) {
        return { status: "denied", error: `tool "${tool}" is not in the permitted toolsets` };
      }
      try {
        const output = await options.execute(
          tool,
          JSON.stringify(input),
          options.runId,
          options.callId,
        );
        return { status: "ok", output };
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
