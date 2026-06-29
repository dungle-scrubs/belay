import { join, resolve, sep } from "node:path";
import {
  abbreviateHome,
  type RootCategory,
  type RootCategoryId,
  resolveRootPolicy,
  rootCategory,
  TREVOR_HOME,
  TREVOR_STATE_HOME,
} from "@trevor/session/node-paths";

// `@trevor/session/node-paths` OWNS root resolution (the env overrides, the default directory names,
// and the D-009 root taxonomy). This module is the host's single CONSUMER entry point: it re-exports
// those helpers so host code reads roots from one place rather than re-deriving home-relative paths.
export {
  type RootCategory,
  type RootCategoryId,
  resolveRootPolicy,
  rootCategory,
  TREVOR_HOME,
  TREVOR_STATE_HOME,
};

/**
 * The host's path/workspace owner: it owns BOTH the user-global base directories AND the workspace
 * root + confinement policy.
 *
 * - User-global (D-081): `TREVOR_HOME` (config) and `TREVOR_STATE_HOME` (runtime state) are imported
 *   from the node-only `@trevor/session/node-paths` subpath, the one project-wide owner of the env
 *   overrides and default directory names. Browser code imports only browser-safe subpaths.
 * - Workspace (D-028): `WORKSPACE_ROOT` plus the confinement policy that was previously in
 *   tools/workspace.ts. These are workspace/path concepts, not tool internals.
 */

/** The user-global `AGENTS.md`, the lowest-precedence (loaded-first) source of the eager context (D-080). */
export const USER_AGENTS_MD = join(TREVOR_HOME, "AGENTS.md");

/**
 * The user-global model-metadata override file: hand-edited JSON that corrects per-model metadata
 * pi-ai's bundled registry gets wrong (e.g. a stale `contextWindow`). Lives in the config home beside
 * `AGENTS.md`, the same way pi-ai keeps `~/.pi/auth.json`. Optional - absent means "no corrections".
 */
export const USER_MODELS_JSON = join(TREVOR_HOME, "models.json");

/**
 * The directory the workspace-confined tools operate inside. Point the agent at a
 * target repo with TREVOR_WORKSPACE; defaults to the host's working directory.
 * Confinement is a path-escape guard (no `../` or absolute path may leave the
 * root), the write-side analogue of the bash safety floor - not a sandbox.
 */
export const WORKSPACE_ROOT = resolve(process.env.TREVOR_WORKSPACE ?? process.cwd());

/**
 * The single workspace-confinement policy: which tools are scoped to WORKSPACE_ROOT, as
 * advertised to the model and enforced by the tools. Confinement has two mechanisms:
 *   - edit (and the edit-family multi_edit) resolve every path through confine() below;
 *   - glob and grep run with `cwd: WORKSPACE_ROOT`.
 * read, write, and bash are deliberately NOT confined - they use the host working
 * directory and accept absolute paths. The system prompt's confinement lines and
 * isWorkspaceConfined() both derive from these lists, so the advertised rule can never
 * drift from the set the tools enforce.
 */
export const WORKSPACE_CONFINED_TOOLS = ["edit", "glob", "grep"] as const;
export const HOST_CWD_TOOLS = ["read", "write", "bash"] as const;

/** Abbreviates the user's home directory to `~` for display (the sanitized path everywhere the host
 *  shows a directory: status announces, `/cd`, `/doctor`, the worktree manager's display closure).
 *  Delegates to the shared `abbreviateHome` so host and services sanitize paths identically. */
export function abbrevHome(absolute: string): string {
  return abbreviateHome(absolute);
}

/** True when a tool's file access is confined to the workspace root (vs. the host cwd). */
export function isWorkspaceConfined(tool: string): boolean {
  return (WORKSPACE_CONFINED_TOOLS as readonly string[]).includes(tool);
}

/** Resolves a path inside the workspace, or throws if it escapes the root. */
export function confine(path: string): string {
  const resolved = resolve(WORKSPACE_ROOT, path);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + sep)) {
    throw new Error(`path escapes workspace root (${path})`);
  }
  return resolved;
}
