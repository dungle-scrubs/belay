import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
 * Responsible for: the discovery order across hook roots, the merged, source-attributed report,
 * and the report-only legacy V1 HOOK.md scan (M10).
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

/** How much of a HOOK.md is read for the executable check - frontmatter only, bounded. */
const MAX_LEGACY_FRONTMATTER_CHARS = 4_096;

/** The two V1 HOOK.md locations, relative to their anchors. */
const LEGACY_PROJECT_HOOKS_DIR = join(".trevor", "hooks");

/** The V1 user hooks home, `~/.trevor/hooks` (V1's config root, not V2's TREVOR_HOME). */
function defaultLegacyUserHooksDir(): string {
  return join(homedir(), ".trevor", "hooks");
}

export interface LegacyHookScanRoots {
  /** Anchors the project scan: `<workspaceRoot>/.trevor/hooks/<id>/HOOK.md`. */
  readonly workspaceRoot: string;
  /** The V1 user hooks dir (`<dir>/<id>/HOOK.md`); default {@link defaultLegacyUserHooksDir}. */
  readonly legacyUserHooksDir?: string;
}

/**
 * The bounded legacy V1 scan (plan 25 M10): one directory level under each V1 hooks home,
 * checking each entry for a `HOOK.md`. REPORT-ONLY - a found file is never parsed into a
 * definition and never executed; the doctor fold turns the report into migration guidance.
 * Deterministic (project before user, directory order) and throw-free: a missing or unreadable
 * directory/file contributes nothing.
 */
export function discoverLegacyHookFiles(roots: LegacyHookScanRoots): readonly LegacyHookFile[] {
  const scans: readonly { readonly dir: string; readonly source: HookSource }[] = [
    { dir: join(roots.workspaceRoot, LEGACY_PROJECT_HOOKS_DIR), source: "project" },
    { dir: roots.legacyUserHooksDir ?? defaultLegacyUserHooksDir(), source: "user" },
  ];

  const found: LegacyHookFile[] = [];
  for (const scan of scans) {
    for (const entry of listDirectories(scan.dir)) {
      const path = join(scan.dir, entry, "HOOK.md");
      const head = readHead(path);
      if (head === null) {
        continue;
      }
      found.push({ path, source: scan.source, executable: frontmatterDeclaresCommand(head) });
    }
  }
  return found;
}

/** The subdirectory names of `dir`, sorted for determinism; [] when missing/unreadable. */
function listDirectories(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The bounded head of a regular file, or null when it does not exist / cannot be read. */
function readHead(path: string): string | null {
  try {
    if (!statSync(path).isFile()) {
      return null;
    }
    return readFileSync(path, "utf8").slice(0, MAX_LEGACY_FRONTMATTER_CHARS);
  } catch {
    return null;
  }
}

/** Whether the leading `---` frontmatter block declares a `command:` (V1's executable shape). */
function frontmatterDeclaresCommand(head: string): boolean {
  if (!head.startsWith("---")) {
    return false;
  }
  const end = head.indexOf("\n---", 3);
  const frontmatter = end >= 0 ? head.slice(0, end) : head;
  return /^command\s*:/m.test(frontmatter);
}

/**
 * Discovers hook definitions across the fixed roots. Deterministic: project before user, entry
 * order within a file preserved. The same id may appear under both roots - provenance (not the
 * id alone) identifies a hook, and the approval key (approval.hookApprovalKey) scopes it.
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
