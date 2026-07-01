import type { SandboxMode } from "./tool-script";

/**
 * The `tool_script` SANDBOX CONTRACT + threat model (plan 16, M2, D-003). This is the pure policy layer: it
 * states what a script may NOT do directly and how the OS-isolation MODE is chosen and reported. It is kept
 * deliberately separate from the host BRIDGE permission policy (`tool-script.ts` toolset validation): the OS
 * sandbox is blast-radius reduction, and the bridge is the authoritative control plane - the bridge policy
 * holds identically whether the OS sandbox is Safehouse, sandbox-exec, or the plain child-process fallback.
 *
 * Deny-first: a script has NO ambient authority. It cannot touch the filesystem, network, environment,
 * other processes, module imports, package installs, the shell, or native code directly; every useful
 * capability is reached only through host-mediated bridge calls (see {@link DENIED_CAPABILITIES}). The OS
 * sandbox enforces this at the process boundary where available; the runner enforces it regardless.
 */

/** The ambient capabilities a script is denied DIRECT (non-bridge) access to. */
export type DeniedCapability =
  | "filesystem"
  | "network"
  | "environment"
  | "process"
  | "import"
  | "package"
  | "shell"
  | "native";

export const DENIED_CAPABILITIES: readonly DeniedCapability[] = [
  "filesystem",
  "network",
  "environment",
  "process",
  "import",
  "package",
  "shell",
  "native",
];

/** The facts that decide which sandbox mode a child runner launches under. */
export interface SandboxEnvironment {
  /** `process.platform` (or equivalent). Only `darwin` has the sandbox-exec/Safehouse OS layer. */
  readonly platform: string;
  /** Whether Agent Safehouse is installed + configured. */
  readonly safehouseAvailable: boolean;
  /** Whether `/usr/bin/sandbox-exec` resolves (macOS). */
  readonly sandboxExecAvailable: boolean;
}

/**
 * Selects the sandbox mode for a run: prefer Safehouse, else macOS `sandbox-exec`, else the plain
 * child-process boundary. There is no ambient-access mode - the WEAKEST outcome is `child-process`, where
 * isolation comes from the process boundary + the runner granting no ambient capabilities, and the bridge
 * policy is unchanged.
 */
export function selectSandboxMode(env: SandboxEnvironment): SandboxMode {
  if (env.safehouseAvailable) {
    return "safehouse";
  }
  if (env.platform === "darwin" && env.sandboxExecAvailable) {
    return "sandbox-exec";
  }
  return "child-process";
}

/**
 * The mode to fall back to when a chosen OS-sandbox launch FAILS: always the child-process boundary. A
 * launch failure never weakens the bridge policy and never drops to no isolation - it degrades to the
 * process boundary and reports that mode so the run is still visibly bounded.
 */
export function fallbackSandboxMode(_chosen: SandboxMode): SandboxMode {
  return "child-process";
}
