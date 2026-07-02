import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { WORKSPACE_ROOT } from "@host/boot/paths";
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
 *
 * Responsible for: resolving the child runner's launch - sandbox mode selection, profile wiring,
 * the boot probe, and the fail-closed unsandboxed refusal.
 * Not for: the profile text itself (sandbox-profile.ts) or the actual spawn (spawn.ts).
 */

/**
 * The launch resolution: either a spawnable command under a known mode, or a REFUSAL. A refusal is the
 * fail-closed default when no OS sandbox can confine the child (plan 16 M4 hardening): running untrusted
 * model code in a plain child process grants it ambient fs/network/process authority (the in-process global
 * shadowing is not a hard boundary), so by default that is refused rather than silently allowed.
 */
export type LaunchResolution =
  | {
      readonly ok: true;
      readonly command: readonly string[];
      readonly sandboxMode: SandboxMode;
      /** The applied profile's path-free hash, for /doctor - present only when an OS profile is in effect. */
      readonly policyHash?: string;
    }
  | { readonly ok: false; readonly reason: string };

export interface ResolveLaunchConfig {
  /** The one directory the sandboxed child may write to (its pipe/scratch dir). */
  readonly scratchDir: string;
  /** Sandbox facts (injectable for tests); defaults to a live probe. */
  readonly env?: SandboxEnvironment;
  /** The runtime command that runs the entry (injectable); defaults to node+tsx+entry. */
  readonly runtimeCommand?: readonly string[];
  /** Whether a sandboxed runtime boots (injectable for tests); defaults to a real `--version` probe. */
  readonly probe?: (profile: string, runtimePath: string) => Promise<boolean>;
  /** Explicitly permit the UNSANDBOXED child-process fallback (reduced isolation). Default: the
   *  `TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED=1` env opt-in. Without it, no-OS-sandbox is refused. */
  readonly allowUnsandboxed?: boolean;
}

/** How long the boot probe may run before it is treated as a failure - it is a `--version` print, so a
 *  few seconds is generous; the cap stops a wedged `sandbox-exec` from hanging the whole turn. */
const PROBE_TIMEOUT_MS = 5_000;

/** Probes whether the runtime can boot under a profile by running `<runtime> --version` sandboxed. Resolves
 *  false (never hangs) if the probe errors or exceeds {@link PROBE_TIMEOUT_MS}. */
export function defaultSandboxProbe(profile: string, runtimePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(SANDBOX_EXEC_PATH, ["-p", profile, runtimePath, "--version"], {
      stdio: "ignore",
    });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, PROBE_TIMEOUT_MS);
    // Do not keep the event loop alive on this timer alone.
    timer.unref?.();
    child.on("exit", (code) => finish(code === 0));
    child.on("error", () => finish(false));
  });
}

/** The containing directories of the absolute-path args in the runtime command (the entry/loader files),
 *  so the deny-read profile lets the child read the modules it boots from - not just the Node prefix. */
function loaderReadRoots(runtime: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const arg of runtime.slice(1)) {
    if (arg.startsWith("/")) {
      roots.add(dirname(arg));
    }
  }
  return [...roots];
}

export async function resolveRunnerLaunch(config: ResolveLaunchConfig): Promise<LaunchResolution> {
  const env = config.env ?? probeSandboxEnvironment();
  const runtime = config.runtimeCommand ?? defaultRunnerCommand();
  const allowUnsandboxed =
    config.allowUnsandboxed ?? process.env.TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED === "1";
  const mode = selectSandboxMode(env);

  if (mode === "sandbox-exec") {
    const runtimePath = runtime[0] ?? "";
    const profile = buildDenyFirstProfile({
      runtimePath,
      scratchDir: config.scratchDir,
      // Reads are deny-by-default; allow the workspace (the read tools operate there) + the loader/entry
      // dirs the child must read to boot. The pnpm-store boot surface is what the deep-isolation re-review
      // validates - where the child cannot boot under this, the probe below fails and the run fails closed.
      readRoots: [WORKSPACE_ROOT, ...loaderReadRoots(runtime)],
    });
    const probe = config.probe ?? defaultSandboxProbe;
    if (await probe(profile, runtimePath)) {
      return {
        ok: true,
        command: sandboxExecCommand(profile, runtime),
        sandboxMode: "sandbox-exec",
        policyHash: sandboxPolicyHash(profile),
      };
    }
    // The OS profile could not launch: fall back to the child-process boundary ONLY if explicitly allowed.
  }

  // No OS sandbox in effect (non-macOS, no profile, or a failed launch). FAIL CLOSED by default: an
  // unsandboxed child grants ambient authority, so refuse unless the operator opted in.
  if (!allowUnsandboxed) {
    return {
      ok: false,
      reason:
        "no OS sandbox available for tool_script; refusing an unsandboxed run (set TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED=1 to permit reduced isolation)",
    };
  }
  return { ok: true, command: runtime, sandboxMode: fallbackSandboxMode("sandbox-exec") };
}
