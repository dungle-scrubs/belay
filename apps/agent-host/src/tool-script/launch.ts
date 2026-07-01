import { spawn } from "node:child_process";
import {
  fallbackSandboxMode,
  type SandboxEnvironment,
  type SandboxMode,
  selectSandboxMode,
} from "@trevor/session";
import {
  buildDenyFirstProfile,
  probeSandboxEnvironment,
  SANDBOX_EXEC_PATH,
  sandboxExecCommand,
  sandboxPolicyHash,
} from "./sandbox-profile";
import { defaultRunnerCommand } from "./spawn";

/**
 * Resolves HOW to launch the `tool_script` child runner (plan 16, M4): it picks the sandbox mode
 * ({@link selectSandboxMode}), and when that mode is macOS `sandbox-exec` it builds the deny-first profile,
 * wraps the runtime command in the launcher, and PROBES that the sandboxed runtime can actually boot. If the
 * probe fails - a Seatbelt profile that Node cannot start under is common - it DEGRADES to the plain
 * child-process command and reports `child-process` mode. The bridge policy is never weakened by this
 * fallback (D-003): the OS sandbox is blast-radius reduction, the host bridge is the authoritative control.
 */

export interface ResolvedLaunch {
  /** The command+args to spawn (possibly `sandbox-exec`-wrapped). */
  readonly command: readonly string[];
  /** The mode actually in effect (after any launch-failure fallback). */
  readonly sandboxMode: SandboxMode;
  /** The applied profile's path-free hash, for /doctor - present only when an OS profile is in effect. */
  readonly policyHash?: string;
}

export interface ResolveLaunchConfig {
  /** The one directory the sandboxed child may write to (its pipe/scratch dir). */
  readonly scratchDir: string;
  /** Sandbox facts (injectable for tests); defaults to a live probe. */
  readonly env?: SandboxEnvironment;
  /** The runtime command that runs the entry (injectable); defaults to node+tsx+entry. */
  readonly runtimeCommand?: readonly string[];
  /** Whether a sandboxed runtime boots (injectable for tests); defaults to a real `--version` probe. */
  readonly probe?: (profile: string, runtimePath: string) => Promise<boolean>;
}

/** Probes whether the runtime can boot under a profile by running `<runtime> --version` sandboxed. */
export function defaultSandboxProbe(profile: string, runtimePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(SANDBOX_EXEC_PATH, ["-p", profile, runtimePath, "--version"], {
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function resolveRunnerLaunch(config: ResolveLaunchConfig): Promise<ResolvedLaunch> {
  const env = config.env ?? probeSandboxEnvironment();
  const runtime = config.runtimeCommand ?? defaultRunnerCommand();
  const mode = selectSandboxMode(env);

  if (mode === "sandbox-exec") {
    const runtimePath = runtime[0] ?? "";
    const profile = buildDenyFirstProfile({ runtimePath, scratchDir: config.scratchDir });
    const probe = config.probe ?? defaultSandboxProbe;
    if (await probe(profile, runtimePath)) {
      return {
        command: sandboxExecCommand(profile, runtime),
        sandboxMode: "sandbox-exec",
        policyHash: sandboxPolicyHash(profile),
      };
    }
    // The OS profile could not launch: degrade to the child-process floor, bridge policy unchanged.
    return { command: runtime, sandboxMode: fallbackSandboxMode("sandbox-exec") };
  }

  return { command: runtime, sandboxMode: mode };
}
