import { join } from "node:path";
import { USER_HOOKS_JSON, WORKSPACE_ROOT } from "@host/boot/paths";
import {
  type HookConfigIssue,
  type HookDefinition,
  type HookSource,
  loadHooksFile,
} from "./config";

/**
 * Bounded hook discovery with source provenance (plan 25 M1, D-001). Exactly two roots in the
 * first cut, consulted in a fixed order: the PROJECT root (`<workspace>/.trevor/hooks.json`,
 * following the established `.trevor/` project-config home that rules already use) and the USER
 * root (`<TREVOR_HOME>/hooks.json`, following the optional-JSON-config precedent of
 * mcp-servers.json). The plan's local/shared scopes have no repo precedent yet and are
 * deliberately NOT invented here; the provenance model (`HookSource` on every definition and
 * issue) is where a later scope slots in. Discovery is deterministic - root order is fixed and
 * file entry order is preserved - and it never throws: a missing file is silently empty, a
 * malformed file falls back per loadJsonConfig, and bad entries surface as issues.
 *
 * Responsible for: the discovery order across hook roots and the merged, source-attributed report.
 * Not for: entry validation (./config), trust/approval (./trust, ./approval), or execution (M3).
 */

/** The project hooks file, relative to the workspace root - `.trevor/` is the project-config home. */
export const PROJECT_HOOKS_FILE = join(".trevor", "hooks.json");

export interface HookDiscoveryRoots {
  readonly projectHooksPath: string;
  readonly userHooksPath: string;
}

/** One consulted root: its scope label and the absolute file path it reads. */
export interface HookRoot {
  readonly source: HookSource;
  readonly path: string;
}

export interface HookDiscoveryReport {
  /** Every discovered definition, project entries first, each stamped with its source. */
  readonly hooks: readonly HookDefinition[];
  /** Every diagnostic from every root, in the same deterministic order. */
  readonly issues: readonly HookConfigIssue[];
  /** The roots consulted, in discovery order, for Doctor/debug provenance. */
  readonly roots: readonly HookRoot[];
}

/**
 * One legacy V1 `HOOK.md` handler found near a hook root (plan 25 M10, D-009): V1 kept hooks as
 * `.trevor/hooks/<id>/HOOK.md` files with frontmatter. V2 REPORTS them for migration - discovery
 * never parses them into definitions and never executes them. `executable` marks a file whose
 * frontmatter declares a `command:` (the V1 executable-handler shape) vs a prompt-only file.
 */
export interface LegacyHookFile {
  /** Absolute path to the HOOK.md file (abbreviate before display). */
  readonly path: string;
  /** Which root's tree it was found under. */
  readonly source: HookSource;
  /** Whether the frontmatter declares a `command:` - the shape that MUST be migrated. */
  readonly executable: boolean;
}

/** The default roots: the workspace's `.trevor/hooks.json` plus the user-global hooks.json. */
export function defaultHookDiscoveryRoots(
  workspaceRoot: string = WORKSPACE_ROOT,
): HookDiscoveryRoots {
  return {
    projectHooksPath: join(workspaceRoot, PROJECT_HOOKS_FILE),
    userHooksPath: USER_HOOKS_JSON,
  };
}

/**
 * Discovers hook definitions across the fixed roots. Deterministic: project before user, entry
 * order within a file preserved. The same id may appear under both roots - provenance (not the
 * id alone) identifies a hook, and the approval key is `<source>:<id>`.
 */
export function discoverHooks(
  roots: HookDiscoveryRoots = defaultHookDiscoveryRoots(),
  read?: (path: string) => string,
): HookDiscoveryReport {
  const consulted: readonly HookRoot[] = [
    { source: "project", path: roots.projectHooksPath },
    { source: "user", path: roots.userHooksPath },
  ];

  const hooks: HookDefinition[] = [];
  const issues: HookConfigIssue[] = [];

  for (const root of consulted) {
    const config = loadHooksFile(root.path, root.source, read);
    hooks.push(...config.hooks);
    issues.push(...config.issues);
  }

  return { hooks, issues, roots: consulted };
}
