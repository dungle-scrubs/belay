import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { SandboxEnvironment } from "@trevor/session";

/**
 * The macOS `sandbox-exec` (Seatbelt) profile generator + launcher wrapping for the `tool_script` child
 * runner (plan 16, M4). This turns the "deny-first, host-bridge-only" contract (M2) into a concrete OS
 * profile: DENY by default, allow only the broad file-READS the runtime needs to boot, exec of ONLY the
 * runtime binary, and file-WRITES ONLY under the runner's own scratch dir - so even if a script escaped the
 * in-process JS boundary, it still cannot write outside scratch, reach the network, or exec anything else.
 *
 * The OS sandbox is blast-radius reduction, NOT the authoritative control - the host bridge (M5) is - so a
 * profile that cannot launch degrades to the child-process boundary (M2 `fallbackSandboxMode`) without
 * weakening the bridge. The policy hash lets `/doctor` report WHICH profile ran without leaking its paths.
 */

/** The macOS sandbox launcher. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

export interface SandboxProfileInput {
  /** The runtime binary the profile permits exec of (e.g. the Node executable). */
  readonly runtimePath: string;
  /** The one directory the child may WRITE to (its pipe/scratch dir under the temp root). */
  readonly scratchDir: string;
}

/**
 * Builds a deny-first Seatbelt profile. `deny default` blocks everything; the allows are the minimum for a
 * Node/tsx child to boot and talk to the host over stdio - broad reads, fork, exec of the runtime only, the
 * mach/sysctl lookups Node needs, and writes confined to the scratch dir. Network and writes elsewhere stay
 * denied by default.
 */
export function buildDenyFirstProfile(input: SandboxProfileInput): string {
  return [
    "(version 1)",
    "(deny default)",
    // Node needs broad READ access to boot (system frameworks, dyld cache, its own tree). Reads are not a
    // blast-radius concern - the script has no fs module, and denying reads just prevents Node from starting.
    "(allow file-read*)",
    "(allow file-read-metadata)",
    // Threads/child boot, but exec ONLY the runtime binary - never an arbitrary spawned process.
    "(allow process-fork)",
    `(allow process-exec (literal ${sbplString(input.runtimePath)}))`,
    // The lookups Node/libuv require; harmless without network/exec.
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    // Writes ONLY under the runner's scratch dir (pipes/temp); everything else stays denied by default.
    `(allow file-write* (subpath ${sbplString(input.scratchDir)}))`,
    '(allow file-write-data (literal "/dev/null"))',
    // No `(allow network*)` line: network is denied by the default.
  ].join("\n");
}

/** Escapes a path for an SBPL string literal. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Wraps an inner runtime command so it launches under the given Seatbelt profile. */
export function sandboxExecCommand(profile: string, innerCommand: readonly string[]): string[] {
  return [SANDBOX_EXEC_PATH, "-p", profile, ...innerCommand];
}

/** A short, path-free hash of a profile - safe to surface in diagnostics (/doctor) to identify the policy. */
export function sandboxPolicyHash(profile: string): string {
  return createHash("sha256").update(profile).digest("hex").slice(0, 16);
}

/** Probes the host for the sandbox facts M2's {@link selectSandboxMode} consumes. */
export function probeSandboxEnvironment(
  env: { readonly platform: string; readonly safehouseAvailable?: boolean } = {
    platform: process.platform,
  },
): SandboxEnvironment {
  return {
    platform: env.platform,
    safehouseAvailable: env.safehouseAvailable ?? false,
    sandboxExecAvailable: env.platform === "darwin" && existsSync(SANDBOX_EXEC_PATH),
  };
}
