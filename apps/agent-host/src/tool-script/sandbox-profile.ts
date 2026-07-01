import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SandboxEnvironment } from "@trevor/session";
import { shortSha16 } from "./hash";

/**
 * The macOS `sandbox-exec` (Seatbelt) profile generator + launcher wrapping for the `tool_script` child
 * runner (plan 16, M4). This turns the "deny-first, host-bridge-only" contract (M2) into a concrete OS
 * profile: DENY by default, allow file-READS only under the roots the runtime needs to boot plus the
 * workspace the read tools operate in, exec of ONLY the runtime binary, and file-WRITES ONLY under the
 * runner's own scratch dir - so even if a script escaped the in-process JS boundary, it still cannot read
 * the user's secrets outside the workspace, write outside scratch, reach the network, or exec anything else.
 *
 * READ CONFINEMENT (plan 16 M4 hardening): reads are DENY-BY-DEFAULT. A blanket `(allow file-read*)` would
 * let an escaped script read the user's secrets under `$HOME` (SSH keys, provider auth tokens, the host's
 * own env files), defeating the confidentiality boundary; instead reads are allowed only under an explicit
 * allowlist. Whether a
 * Node/tsx child actually boots under this tightened read policy across pnpm/store layouts is exactly what
 * the deep-isolation re-review validates before merge; where it cannot boot, the launch probe fails and the
 * run FAILS CLOSED (never silently unsandboxed).
 *
 * The OS sandbox is blast-radius reduction, NOT the authoritative control - the host bridge (M5) is - so a
 * profile that cannot launch degrades per the launch policy without weakening the bridge. The policy hash
 * lets `/doctor` report WHICH profile ran without leaking its paths.
 */

/** The macOS sandbox launcher. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * System directories a macOS Node/tsx child must READ to boot: the OS frameworks + dyld shared cache, the
 * per-user temp/dyld-closure trees under `/private/var`, and the common runtime install prefixes. None hold
 * user secrets, so allowing reads here is not a confidentiality concern; the point is to NOT allow reads
 * everywhere else (notably `$HOME`).
 */
const SYSTEM_READ_ROOTS: readonly string[] = [
  "/usr",
  "/System",
  "/Library",
  "/private/var/db/dyld",
  "/private/var/folders",
  "/private/tmp",
  "/private/etc",
  "/dev",
  "/bin",
  "/sbin",
  "/opt/homebrew",
  "/opt/local",
];

export interface SandboxProfileInput {
  /** The runtime binary the profile permits exec of (e.g. the Node executable). */
  readonly runtimePath: string;
  /** The one directory the child may WRITE to (its pipe/scratch dir under the temp root). */
  readonly scratchDir: string;
  /** Extra absolute directories reads are allowed under: the workspace the read tools operate in, and any
   *  loader/module trees (Node prefix, tsx/node_modules, the entry dir) the child must read to boot.
   *  Everything outside the allowlist - the user's secrets under `$HOME` - stays deny-read. */
  readonly readRoots?: readonly string[];
}

/**
 * Builds a deny-first Seatbelt profile. `deny default` blocks everything; reads are allowed ONLY under the
 * system boot roots + the runtime's own prefix + the caller's `readRoots` (workspace, loader trees) + the
 * scratch dir. Fork, exec of the runtime only, the mach/sysctl lookups Node needs, and writes confined to
 * scratch are allowed. Network, writes elsewhere, and reads outside the allowlist stay denied by default.
 */
export function buildDenyFirstProfile(input: SandboxProfileInput): string {
  // The runtime's install prefix (e.g. `.../node-vXX` from `.../bin/node`) must be readable to boot.
  const runtimePrefix = dirname(dirname(input.runtimePath));
  const readRoots = dedupePaths([
    ...SYSTEM_READ_ROOTS,
    runtimePrefix,
    ...(input.readRoots ?? []),
    input.scratchDir,
  ]);
  return [
    "(version 1)",
    "(deny default)",
    // Reads are DENY-BY-DEFAULT: allow content reads ONLY under the boot/workspace roots below, so an
    // escaped script cannot read secrets under $HOME. Bare metadata (stat) of any path is content-free.
    ...readRoots.map((root) => `(allow file-read* (subpath ${sbplString(root)}))`),
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

/** De-duplicates paths, preserving order (a profile with repeated allow lines is valid but noisy). */
function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
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
  return shortSha16(profile);
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
