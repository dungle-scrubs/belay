import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { TOOLSET_TOOLS, type ToolScriptToolset } from "@trevor/session";
import { WORKSPACE_ROOT } from "../paths";
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
 * Canonicalizes `p` by realpath-resolving its LONGEST EXISTING ANCESTOR (so a symlinked directory anywhere
 * in the path is followed to its true target) and re-appending the not-yet-existing remainder. This handles
 * a real file (fully realpath'd), a not-yet-created file (parent realpath'd), and a glob pattern (its magic
 * lives in the non-existent remainder, appended verbatim). A non-ENOENT stat error degrades to lexical for
 * that segment. Pure `resolve()` would miss symlinks; `readFile` in the host follows them.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) {
      return p;
    }
    return join(canonicalize(parent), basename(p));
  }
}

/** True when `path`, resolved against `root` then canonicalized (symlinks followed), points OUTSIDE the
 *  canonical workspace root. `canonicalRoot` is precomputed once (root is fixed for a run). */
function escapesRoot(root: string, canonicalRoot: string, path: string): boolean {
  const canonical = canonicalize(resolve(root, path));
  return canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + sep);
}

/** The first confined path field whose value escapes the workspace root, or null when every path stays in. */
function findPathEscape(
  root: string,
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
      if (typeof candidate === "string" && escapesRoot(root, canonicalRoot, candidate)) {
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
  /** The confinement root every path-bearing bridge argument must stay within. Defaults to the host's
   *  `WORKSPACE_ROOT`; injectable so the confinement is unit-testable without touching the real cwd. */
  readonly workspaceRoot?: string;
}

/**
 * Builds a {@link ToolScriptBridge} for one run: a call to a tool in the permitted set routes through
 * `execute` (`ok` with its output, or `failed` if the registry throws); any other tool is `denied` without
 * executing. A permitted tool whose path argument escapes the workspace root is also `denied`.
 */
export function createToolScriptBridge(options: ToolScriptBridgeOptions): ToolScriptBridge {
  const allowed = allowedTools(options.toolsets);
  const root = options.workspaceRoot ?? WORKSPACE_ROOT;
  // Canonicalize the root ONCE - the confinement compares each candidate's realpath against it.
  const canonicalRoot = canonicalize(root);
  return {
    async call(tool, input) {
      if (!allowed.has(tool)) {
        return { status: "denied", error: `tool "${tool}" is not in the permitted toolsets` };
      }
      const escapingPath = findPathEscape(root, canonicalRoot, tool, input);
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
