import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { HookDefinition } from "./config";

/**
 * Hook trust fingerprints (plan 25 M2, D-006). A hook is a command the host will run, so trust
 * is a sha256 over WHAT would run: the canonical JSON of the normalized config (recursively
 * sorted keys, so raw-file key order can never flip a hash) plus the contents of every locally
 * referenced script. The local-path rule: a command or arg value that LOOKS like a path (starts
 * with "." or contains a "/") is resolved - absolute as-is, relative against the hook's base
 * dir (workspace root for project hooks, config home for user hooks) - and, when it names an
 * existing file, its contents join the hash. Bare tokens ("node", "--strict") never touch the
 * filesystem. A path-like COMMAND that resolves to nothing is the distinct `missing-script`
 * state: it can never execute, whatever the approval store says. Provenance (`source`) is
 * deliberately NOT hashed - the approval KEY (`<source>:<id>`) scopes it, so the same bytes
 * approved as a project hook are still unapproved as a user hook.
 *
 * Responsible for: computing stable sha256 trust fingerprints and deriving the trust status.
 * Not for: storing approval decisions or gating execution - ./approval owns those.
 */

/** The filesystem capability the fingerprint needs, injectable so tests never touch disk. */
export interface HookTrustIo {
  readonly isFile: (absolutePath: string) => boolean;
  readonly readFile: (absolutePath: string) => string;
}

export interface HookTrustFingerprint {
  /** `sha256:<hex>` over canonical config + referenced local script contents. */
  readonly hash: string;
  /** The as-written command/arg values that resolved to existing local files, in config order. */
  readonly referencedFiles: readonly string[];
  /** True when the command is path-like but no file exists at its resolution. */
  readonly missingScript: boolean;
}

/**
 * Where a hook stands against its stored approval (D-006). Everything except `approved` keeps
 * the execution gate closed while still surfacing as a diagnostic.
 */
export type HookTrustStatus = "approved" | "unapproved" | "changed" | "missing-script";

const REAL_IO: HookTrustIo = {
  isFile: (absolutePath) => {
    try {
      return statSync(absolutePath).isFile();
    } catch {
      return false;
    }
  },
  readFile: (absolutePath) => readFileSync(absolutePath, "utf8"),
};

/**
 * Computes the trust fingerprint for one hook definition. `baseDir` anchors relative script
 * references: the workspace root for project hooks, the config home for user hooks.
 */
export function computeHookTrustFingerprint(
  hook: HookDefinition,
  baseDir: string,
  io: HookTrustIo = REAL_IO,
): HookTrustFingerprint {
  const hash = createHash("sha256");
  hash.update(
    canonicalJson({
      args: hook.args,
      command: hook.command,
      enabled: hook.enabled,
      event: hook.event,
      id: hook.id,
      timeoutMs: hook.timeoutMs,
    }),
  );

  const referencedFiles: string[] = [];
  const seenResolved = new Set<string>();
  let missingScript = false;

  for (const candidate of [hook.command, ...hook.args]) {
    if (!looksLikeLocalPath(candidate)) {
      continue;
    }
    const resolved = isAbsolute(candidate) ? candidate : resolve(baseDir, candidate);
    if (!io.isFile(resolved)) {
      if (candidate === hook.command) {
        missingScript = true; // the executable itself is absent; args may be output paths
      }
      continue;
    }
    if (seenResolved.has(resolved)) {
      continue;
    }
    seenResolved.add(resolved);
    referencedFiles.push(candidate);
    hash.update("\nfile:");
    hash.update(candidate);
    hash.update("\n");
    hash.update(io.readFile(resolved));
  }

  return { hash: `sha256:${hash.digest("hex")}`, referencedFiles, missingScript };
}

/**
 * Derives the trust status from a fingerprint and the hash the approval store holds for the
 * hook's key (undefined when never approved). `missing-script` wins over everything - a hook
 * whose executable is gone is not runnable regardless of stored approvals.
 */
export function evaluateHookTrust(
  fingerprint: HookTrustFingerprint,
  approvedHash: string | undefined,
): HookTrustStatus {
  if (fingerprint.missingScript) {
    return "missing-script";
  }
  if (approvedHash === undefined) {
    return "unapproved";
  }
  return approvedHash === fingerprint.hash ? "approved" : "changed";
}

/** Path-like = explicitly dotted or containing a separator; bare tokens are PATH lookups/flags. */
function looksLikeLocalPath(candidate: string): boolean {
  return candidate.startsWith(".") || candidate.includes("/");
}

/** JSON.stringify with recursively sorted object keys, so hashing ignores property order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}
