import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * The host's path/workspace owner: it owns BOTH the user-global base directory AND the workspace
 * root + confinement policy.
 *
 * - User-global (D-081): `TREVOR_HOME` is the ONE source for every user-scoped path. It lives here
 *   (a host, node-only module) rather than in `@trevor/session`, because that package is also
 *   bundled into the browser web app and must stay free of node built-ins (`node:os`/`node:path`).
 *   The launcher (`trevor-cli`) keeps its own one-line copy for the same reason (D-041).
 * - Workspace (D-028): `WORKSPACE_ROOT` plus the confinement policy that was previously in
 *   tools/workspace.ts. These are workspace/path concepts, not tool internals.
 */

export const TREVOR_HOME = resolve(process.env.TREVOR_HOME ?? join(homedir(), ".trevorV2"));

export const TREVOR_STATE_HOME = resolve(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "trevorV2",
);

/** The user-global `AGENTS.md`, the lowest-precedence (loaded-first) source of the eager context (D-080). */
export const USER_AGENTS_MD = join(TREVOR_HOME, "AGENTS.md");

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
