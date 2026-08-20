import { join, resolve, sep } from "node:path";
import {
  abbreviateHome,
  BELAY_HOME,
  BELAY_STATE_HOME,
  type RootCategory,
  type RootCategoryId,
  resolveRootPolicy,
  rootCategory,
} from "@belay/session/node-paths";

// `@belay/session/node-paths` OWNS root resolution (the env overrides, the default directory names,
// and the D-009 root taxonomy). This module is the host's single CONSUMER entry point: it re-exports
// those helpers so host code reads roots from one place rather than re-deriving home-relative paths.
export {
  BELAY_HOME,
  BELAY_STATE_HOME,
  type RootCategory,
  type RootCategoryId,
  resolveRootPolicy,
  rootCategory,
};

/**
 * The host's path/workspace owner: it owns BOTH the user-global base directories AND the workspace
 * root + confinement policy.
 *
 * - User-global (D-081): `BELAY_HOME` (config) and `BELAY_STATE_HOME` (runtime state) are imported
 *   from the node-only `@belay/session/node-paths` subpath, the one project-wide owner of the env
 *   overrides and default directory names. Browser code imports only browser-safe subpaths.
 * - Workspace (D-028): `WORKSPACE_ROOT` plus the confinement policy that was previously in
 *   tools/workspace.ts. These are workspace/path concepts, not tool internals.
 *
 * Responsible for: the host's path constants (user config files, workspace root) + confinement.
 * Not for: root resolution/env overrides - @belay/session/node-paths owns those (re-exported).
 */

/** The user-global `AGENTS.md`, the lowest-precedence (loaded-first) source of the eager context (D-080). */
export const USER_AGENTS_MD = join(BELAY_HOME, "AGENTS.md");

/**
 * The user-global model-metadata override file: hand-edited JSON that corrects per-model metadata
 * pi-ai's bundled registry gets wrong (e.g. a stale `contextWindow`). Lives in the config home beside
 * `AGENTS.md`, the same way pi-ai keeps `~/.pi/auth.json`. Optional - absent means "no corrections".
 */
export const USER_MODELS_JSON = join(BELAY_HOME, "models.json");

/**
 * The user's active output-style preference (plan 03): a small `{ activeStyle }` JSON under the config
 * home, written when `/style` selects a style and read at turn start for run attribution. Host-owned and
 * portable (it travels with `BELAY_HOME`), separate from provider/model/reasoning preferences.
 */
export const USER_STYLE_JSON = join(BELAY_HOME, "style.json");

/**
 * The user's Vim-mode prompt preference (plan 06): a small `{ enabled }` JSON under the config home,
 * read at host startup and announced to the web (so opt-in Vim motions follow Belay sessions on this
 * machine). Host-owned + portable (travels with `BELAY_HOME`); disabled unless this file enables it.
 */
export const USER_VIM_JSON = join(BELAY_HOME, "vim.json");

/**
 * The user's model-selection preference (plan 51): a small `{ default, pinned }` JSON under the config
 * home holding the durable DEFAULT model (the one a fresh session starts on) and the FAVORITES (pinned
 * models). Host-owned + portable (travels with `BELAY_HOME`) and shared across every session/browser
 * talking to this host - which is what makes the default durable, closing the per-browser "reset to
 * qwen" bug. Announced on `host.online` and mutated by the set-default / toggle-favorite command.
 */
export const USER_MODEL_PREFS_JSON = join(BELAY_HOME, "model-prefs.json");

/**
 * The user's local-admission config (plan 11): an optional `{ defaultCapacity, staleAfterMs,
 * capacityByResource }` JSON under the config home, read at host startup to size local-model concurrency.
 * Absent means the conservative default (one active generation per resource). Host-owned + portable.
 */
export const USER_ADMISSION_JSON = join(BELAY_HOME, "admission.json");

/**
 * The named MCP server registry file (plan 23): an optional `{ servers: { "<name>": ... } }` JSON
 * under the config home, read at host startup to configure MCP servers (tool-proxy is just one
 * ordinary named entry, D-001). Absent means no MCP servers. Host-owned + portable.
 */
export const USER_MCP_SERVERS_JSON = join(BELAY_HOME, "mcp-servers.json");

/**
 * The indexed source-recall provider config (plan 38): an optional
 * `{ providers: { "<id>": { kind, endpoint, enabled, ... } } }` JSON under the config home, read at
 * host startup to configure which indexed-source backends (`source-recall`, Aleutian Trace) are
 * available. Absent means no source-recall provider (the tools degrade to "unavailable"). Host-owned
 * + portable; endpoints and repo/project mapping only - no secrets.
 */
export const USER_SOURCE_RECALL_JSON = join(BELAY_HOME, "source-recall.json");

/**
 * The user-global hooks file (plan 25): an optional `{ hooks: { "<id>": ... } }` JSON under the
 * config home, the USER root of hook discovery (project hooks live in the workspace's
 * `.belay/hooks.json`). Hooks from either root never execute before explicit approval (D-006).
 * Host-owned + portable; absent means no user hooks.
 */
export const USER_HOOKS_JSON = join(BELAY_HOME, "hooks.json");

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

/** Resolves a path inside a GIVEN workspace root, or throws if it escapes it. Parameterized so a
 *  worktree-isolated workflow leaf can confine against its own tree instead of the global root
 *  (plan 21 M6, D-024); `confine` is the global-root default. */
export function confineIn(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes workspace root (${path})`);
  }
  return resolved;
}

/** Resolves a path inside the (global) workspace, or throws if it escapes the root. */
export function confine(path: string): string {
  return confineIn(WORKSPACE_ROOT, path);
}
