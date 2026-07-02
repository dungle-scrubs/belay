import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson } from "@host/boot/canonical-json";
import type { HookDefinition } from "./config";

/**
 * Hook trust fingerprints (plan 25 M2, D-006). A hook is a command the host will run, so trust
 * is a sha256 over WHAT would run: the canonical JSON of the normalized config (recursively
 * sorted keys, so raw-file key order can never flip a hash) plus the contents of every locally
 * referenced script. THE TRUST BOUNDARY: the hash covers the normalized config plus the
 * entry-point file contents of local path-like references ONLY - a bare command resolved
 * through PATH ("node", "python3") and anything a script transitively sources, imports, or
 * execs are NOT verified, so approval attests to the config and its entry-point scripts, not
 * the whole transitive execution surface. The local-path rule: a command or arg value that
 * LOOKS like a path (starts with "." or contains a "/") is resolved - absolute as-is, relative
 * against the hook's base dir (workspace root for project hooks, config home for user hooks) -
 * and, when it names an existing file, its contents join the hash as a length-prefixed section
 * (so bytes can never migrate across file boundaries with an identical digest). Bare tokens
 * ("node", "--strict") never touch the filesystem. A path-like COMMAND that resolves to nothing
 * is the distinct `missing-script` state: it can never execute, whatever the approval store
 * says. Provenance (`source`) is deliberately NOT hashed - the approval KEY scopes it, so the
 * same bytes approved as a project hook are still unapproved as a user hook.
 *
 * Responsible for: computing stable sha256 trust fingerprints (plus the mtime/size-guarded
 * fingerprint cache) and deriving the trust status.
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
    const content = io.readFile(resolved);
    // Length-prefixed framing: the section header carries the content's byte length, so bytes
    // cannot migrate between a file's content and the next section (or another file) while
    // producing an identical digest.
    hash.update(`\nfile:${candidate}:${Buffer.byteLength(content, "utf8")}\n`);
    hash.update(content);
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

/** One referenced file's freshness probe: enough to detect an edit without re-reading it. */
export interface HookFileStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

/** Stamps one absolute path, or null when it is not (or no longer) a readable regular file. */
export type HookTrustStatFn = (absolutePath: string) => HookFileStamp | null;

/** A per-hook fingerprint cache guarded by the referenced files' mtime+size stamps. */
export interface HookTrustFingerprintCache {
  readonly fingerprintFor: (
    key: string,
    hook: HookDefinition,
    baseDir: string,
  ) => HookTrustFingerprint;
}

const realFileStamp: HookTrustStatFn = (absolutePath) => {
  try {
    const stats = statSync(absolutePath);
    return stats.isFile() ? { mtimeMs: stats.mtimeMs, size: stats.size } : null;
  } catch {
    return null;
  }
};

/**
 * Builds the fingerprint cache the hooks runtime consults per dispatch (25 simplify pass): the
 * expensive part of a fingerprint is re-reading + re-hashing every referenced script, so the
 * cache keeps one fingerprint per hook key and revalidates it with a cheap stat probe
 * (mtimeMs+size per path-like candidate - the same statSync the compute path already pays).
 * Any change - an edit, a deletion, a file appearing where none resolved before - flips a probe
 * and forces a fresh compute, so the D-006 semantics are unchanged: editing a script still
 * re-closes the gate on the very next dispatch. Discovery is cached for the host's lifetime, so
 * a hook's candidate set (config) cannot change under a cached entry.
 */
export function createHookTrustFingerprintCache(
  io: HookTrustIo = REAL_IO,
  stat: HookTrustStatFn = realFileStamp,
): HookTrustFingerprintCache {
  const cache = new Map<
    string,
    {
      readonly probes: readonly (HookFileStamp | null)[];
      readonly fingerprint: HookTrustFingerprint;
    }
  >();

  return {
    fingerprintFor: (key, hook, baseDir) => {
      const probes = localPathCandidates(hook, baseDir).map((path) => stat(path));
      const cached = cache.get(key);
      if (cached && sameProbes(cached.probes, probes)) {
        return cached.fingerprint;
      }
      const fingerprint = computeHookTrustFingerprint(hook, baseDir, io);
      cache.set(key, { probes, fingerprint });
      return fingerprint;
    },
  };
}

/** The resolved path-like candidates (command + args) a fingerprint would consider, in order. */
function localPathCandidates(hook: HookDefinition, baseDir: string): readonly string[] {
  return [hook.command, ...hook.args]
    .filter(looksLikeLocalPath)
    .map((candidate) => (isAbsolute(candidate) ? candidate : resolve(baseDir, candidate)));
}

function sameProbes(
  a: readonly (HookFileStamp | null)[],
  b: readonly (HookFileStamp | null)[],
): boolean {
  return (
    a.length === b.length &&
    a.every((probe, i) => {
      const other = b[i] ?? null;
      if (probe === null || other === null) {
        return probe === other;
      }
      return probe.mtimeMs === other.mtimeMs && probe.size === other.size;
    })
  );
}

/** Path-like = explicitly dotted or containing a separator; bare tokens are PATH lookups/flags. */
function looksLikeLocalPath(candidate: string): boolean {
  return candidate.startsWith(".") || candidate.includes("/");
}
