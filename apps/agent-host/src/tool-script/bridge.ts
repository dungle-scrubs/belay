import { lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { WORKSPACE_ROOT } from "@host/boot/paths";
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
 * WORKSPACE CONFINEMENT (plan 16 M4 hardening): a plain `read` accepts absolute paths and `../` (the host's
 * single-call trust model), but a tool_script runs UNSUPERVISED, BATCHED, untrusted code, so the bridge
 * additionally confines every path-bearing argument to the workspace root - a `read`/`glob`/`grep`/`ast_grep`
 * call that resolves outside the workspace is DENIED before it runs. This holds even when an OS sandbox is
 * also active (defense in depth); the bridge is the authoritative boundary per D-003.
 *
 * The confinement is CANONICALIZING, not lexical: bridge reads run in the privileged HOST (the injected
 * `execute` is the real `executeTool`, and `read` does `readFile`, which FOLLOWS SYMLINKS), so a lexical
 * `resolve()` check would let a symlink inside the workspace (e.g. a pnpm `node_modules` link, or a planted
 * `ws/link -> ~/.ssh`) point a "workspace" path at an outside secret. So every candidate is realpath-resolved
 * (its longest existing ancestor is followed to its true location) and compared against the realpath'd root.
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

/**
 * Per-tool argument fields that carry a FILESYSTEM PATH (not a regex or an AST pattern) and so must stay in
 * the workspace: `read.path`, `glob.pattern` (a workspace-relative glob), `grep.glob`, and `ast_grep`'s
 * `paths`/`globs`. `grep.pattern` (a regex) and `ast_grep.pattern` (an AST pattern) are deliberately absent -
 * they are not paths. A field may hold a string or an array of strings; every entry is checked.
 */
const CONFINED_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["path"],
  glob: ["pattern"],
  grep: ["glob"],
  ast_grep: ["paths", "globs"],
};

/**
 * Tools that resolve a RELATIVE path against the host's live `process.cwd()` rather than `WORKSPACE_ROOT`.
 * Only `read` does (`readFile(args.path)` uses the process cwd; see paths.ts - read is a "host cwd" tool);
 * `glob`/`grep`/`ast_grep` run rooted at `WORKSPACE_ROOT`. The confinement must resolve each candidate
 * against the SAME base the tool will, or a host launched with cwd outside `WORKSPACE_ROOT` could let a
 * relative `read` escape the region. The confinement REGION stays `WORKSPACE_ROOT` for every tool.
 */
const HOST_CWD_BASE_TOOLS: ReadonlySet<string> = new Set(["read"]);

/** A symlink-follow cap: past this the path is a cycle (or pathologically deep); resolve to `/` so any
 *  non-root workspace treats it as an escape (deny) rather than looping forever. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolves `absolute` the way the KERNEL's `open()` does - the resolution `readFile` in the host actually
 * performs - so the confinement check matches the real read. Two subtleties `resolve()`/`realpathSync`
 * get WRONG on macOS:
 *   - `resolve()` collapses `..` as a pure string op BEFORE any symlink is followed, so `link/../x` cancels
 *     to `x` (looks in-workspace) though the kernel climbs out of the link's TARGET.
 *   - macOS `realpath(3)` resolves `..` LEXICALLY (so `realpath(ws/link/..)` returns `ws`), which DESYNCS
 *     from `open()` (which follows `link`, then `..` from the target's real parent).
 * So we walk segments left-to-right: follow each symlink, and apply `..` to the current REAL location. A
 * non-existent segment (a not-yet-created file, or a glob's magic) is a plain name. This is `namei`.
 */
function resolveLikeKernel(absolute: string): string {
  const remaining = absolute.split(sep).filter((s) => s !== "" && s !== ".");
  let current: string = sep;
  let hops = 0;
  while (remaining.length > 0) {
    const segment = remaining.shift() as string;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    let target: string | null = null;
    try {
      if (lstatSync(next).isSymbolicLink()) {
        target = readlinkSync(next);
      }
    } catch {
      // Non-existent / unreadable: a plain component (the kernel would just create/miss it here).
    }
    if (target === null) {
      current = next;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) {
      return sep; // symlink cycle: escape for any non-root workspace.
    }
    // Splice the link's target into the walk: an absolute target restarts at root, a relative one stays
    // rooted at the link's own directory (`current`), then the rest of the original path continues.
    if (isAbsolute(target)) {
      current = sep;
    }
    remaining.unshift(...target.split(sep).filter((s) => s !== "" && s !== "."));
  }
  return current;
}

/** True when `path` (as the tool will actually open it, resolving a relative path against `base`) points
 *  OUTSIDE the canonical workspace region. `canonicalRoot` is precomputed once. The candidate is made
 *  absolute against `base` by STRING concatenation - never `resolve`/`join`, which would collapse `..`
 *  before symlinks. */
function escapesRoot(base: string, canonicalRoot: string, path: string): boolean {
  const absolute = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const canonical = resolveLikeKernel(absolute);
  return canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + sep);
}

/** The first confined path field whose value escapes the workspace region, or null when every path stays
 *  in. Relative paths resolve against `base` (the tool's real resolution base); the region is `canonicalRoot`. */
function findPathEscape(
  base: string,
  canonicalRoot: string,
  tool: string,
  input: unknown,
): string | null {
  const fields = CONFINED_PATH_FIELDS[tool];
  if (!fields || typeof input !== "object" || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && escapesRoot(base, canonicalRoot, candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

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
  /** The confinement REGION every path-bearing bridge argument must stay within. Defaults to the host's
   *  `WORKSPACE_ROOT`; injectable so the confinement is unit-testable without touching the real cwd. */
  readonly workspaceRoot?: string;
  /** The base a `read` relative path resolves against - the host's LIVE cwd, matching `readFile`. Injectable
   *  (a thunk, read per call) so tests can pin it; defaults to `process.cwd()`. `glob`/`grep`/`ast_grep`
   *  always resolve against `workspaceRoot` (their own root), never this. */
  readonly readCwd?: () => string;
}

/**
 * Builds a {@link ToolScriptBridge} for one run: a call to a tool in the permitted set routes through
 * `execute` (`ok` with its output, or `failed` if the registry throws); any other tool is `denied` without
 * executing. A permitted tool whose path argument escapes the workspace root is also `denied`.
 */
export function createToolScriptBridge(options: ToolScriptBridgeOptions): ToolScriptBridge {
  const allowed = allowedTools(options.toolsets);
  const root = options.workspaceRoot ?? WORKSPACE_ROOT;
  const readCwd = options.readCwd ?? (() => process.cwd());
  // Resolve the region ONCE (same kernel-faithful walk) - the confinement compares each candidate against it.
  const canonicalRoot = resolveLikeKernel(root);
  return {
    async call(tool, input) {
      if (!allowed.has(tool)) {
        return { status: "denied", error: `tool "${tool}" is not in the permitted toolsets` };
      }
      // Resolve relative paths against the base the tool ACTUALLY uses: `read` -> the host's live cwd,
      // everything else -> the workspace root. Using the wrong base would desync the check from the read.
      const base = HOST_CWD_BASE_TOOLS.has(tool) ? readCwd() : root;
      const escapingPath = findPathEscape(base, canonicalRoot, tool, input);
      if (escapingPath !== null) {
        return { status: "denied", error: `path "${escapingPath}" escapes the workspace root` };
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
