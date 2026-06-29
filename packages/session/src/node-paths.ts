import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type TrevorPathEnv = Readonly<Record<string, string | undefined>>;

/**
 * Trevor's two user-global roots, kept deliberately separate so config and state never conflate
 * (the XDG split). CONFIG lives in {@link TREVOR_HOME} - hand-edited, portable, backed up; STATE
 * lives in {@link TREVOR_STATE_HOME} - machine-local runtime data the app owns. The node-only owner
 * of both, so every store/host/launcher derives its paths from one place instead of re-joining
 * `~/.trevorV2/...` ad hoc. Browser code imports only browser-safe subpaths.
 */

/** The config home's directory name under `$HOME` (the dotfolder users point `TREVOR_HOME` at). */
export const TREVOR_HOME_DIRNAME = ".trevorV2";

/** The state home's directory name under the XDG state base (`$XDG_STATE_HOME`/`~/.local/state`). */
export const TREVOR_STATE_DIRNAME = "trevorV2";

/**
 * The config home: user-editable, portable configuration - `AGENTS.md`, `.env.op`, `auth.json`,
 * `config.jsonc`. NOT runtime state. Override with `TREVOR_HOME`; defaults to `~/.trevorV2`.
 */
export function resolveTrevorHome(
  env: TrevorPathEnv = process.env,
  home: string = homedir(),
): string {
  return resolve(env.TREVOR_HOME ?? join(home, TREVOR_HOME_DIRNAME));
}

export const TREVOR_HOME = resolveTrevorHome();

/**
 * The state home: machine-local runtime state the app owns - the session-log db, content-addressed
 * blobs, managed worktrees, the host/lock/project registries, logs, and provider observations. Kept
 * out of the config dir so a backup or a config sync never drags the session history along, and a
 * config-dir rename never orphans the data. Precedence: explicit `TREVOR_STATE_HOME`, then
 * `$XDG_STATE_HOME/trevorV2`, then `~/.local/state/trevorV2`.
 */
export function resolveTrevorStateHome(
  env: TrevorPathEnv = process.env,
  home: string = homedir(),
): string {
  if (env.TREVOR_STATE_HOME) {
    return resolve(env.TREVOR_STATE_HOME);
  }
  const base = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return resolve(base, TREVOR_STATE_DIRNAME);
}

export const TREVOR_STATE_HOME = resolveTrevorStateHome();

/**
 * The approved filesystem-root taxonomy (D-009). This module is the ONE owner of where each class of
 * Trevor data lives; consumers (host diagnostics, service defaults, the CLI) read this read model
 * instead of re-deriving home-relative paths. Categories are named by ownership and lifecycle, not by
 * incidental path strings, so the taxonomy survives a directory rename.
 */

/** Whether Trevor writes a root, or only reads an externally-owned one. */
export type RootOwnership = "trevor" | "external";

/** Lifecycle class of a root - how durable and how owned its contents are. */
export type RootLifecycle = "config" | "runtime" | "legacy" | "scratch" | "ephemeral";

/** Stable id for every approved root category. */
export type RootCategoryId =
  | "config"
  | "state"
  | "legacy"
  | "temp"
  | "browser"
  | "external-pi"
  | "external-agents";

/** One approved root category: where a class of data lives, who owns it, and whether it is writable. */
export interface RootCategory {
  readonly id: RootCategoryId;
  readonly label: string;
  readonly ownership: RootOwnership;
  readonly lifecycle: RootLifecycle;
  /** Resolved absolute path, or null for a non-filesystem root (browser storage). */
  readonly path: string | null;
  /** The env var that overrides this root's location, or null when it has none. */
  readonly envOverride: string | null;
  /** Whether new Trevor writes are allowed here (false for legacy and external roots). */
  readonly writable: boolean;
  /** What belongs here, for diagnostics and developer guidance. */
  readonly description: string;
}

/** The legacy `~/.trevor` dotdir from pre-XDG-split runs - detect-only, never a new-write target. */
export const LEGACY_TREVOR_DIRNAME = ".trevor";

/**
 * Resolves the full root taxonomy from injected env + home (pure, so diagnostics and tests stay
 * deterministic). The two writable Trevor roots resolve through {@link resolveTrevorHome} and
 * {@link resolveTrevorStateHome}; legacy/temp/browser/external roots are fixed by policy. Order is
 * stable and meaningful (config, state, legacy, temp, browser, external) so diagnostics can render it
 * directly.
 */
export function resolveRootPolicy(
  env: TrevorPathEnv = process.env,
  home: string = homedir(),
): readonly RootCategory[] {
  return [
    {
      id: "config",
      label: "config",
      ownership: "trevor",
      lifecycle: "config",
      path: resolveTrevorHome(env, home),
      envOverride: "TREVOR_HOME",
      writable: true,
      description: "User settings and editable config (user-global AGENTS.md, config.jsonc).",
    },
    {
      id: "state",
      label: "state",
      ownership: "trevor",
      lifecycle: "runtime",
      path: resolveTrevorStateHome(env, home),
      envOverride: "TREVOR_STATE_HOME",
      writable: true,
      description:
        "All machine-local runtime state: session db, blobs, worktrees, registries, logs, observations, diagnostics.",
    },
    {
      id: "legacy",
      label: "legacy",
      ownership: "trevor",
      lifecycle: "legacy",
      path: join(home, LEGACY_TREVOR_DIRNAME),
      envOverride: null,
      writable: false,
      description:
        "Old ~/.trevor data from pre-XDG-split runs; detect-only, never a new-write target.",
    },
    {
      id: "temp",
      label: "temp",
      ownership: "trevor",
      lifecycle: "scratch",
      path: tmpdir(),
      envOverride: null,
      writable: true,
      description: "OS temp for scratch, transcodes, and short-lived intermediate files.",
    },
    {
      id: "browser",
      label: "browser",
      ownership: "trevor",
      lifecycle: "ephemeral",
      path: null,
      envOverride: null,
      writable: true,
      description:
        "Browser-only ephemeral UI state (sessionStorage drafts/history); not a filesystem root.",
    },
    {
      id: "external-pi",
      label: "external:pi",
      ownership: "external",
      lifecycle: "config",
      path: join(home, ".pi"),
      envOverride: null,
      writable: false,
      description: "pi-ai credential store (~/.pi/auth.json). Externally owned - read-only.",
    },
    {
      id: "external-agents",
      label: "external:agents",
      ownership: "external",
      lifecycle: "config",
      path: join(home, ".agents"),
      envOverride: null,
      writable: false,
      description: "Shared agents and skills (~/.agents). Externally owned - read-only.",
    },
  ];
}

/** Looks up one approved root category by id, throwing on an unknown id. */
export function rootCategory(
  id: RootCategoryId,
  env: TrevorPathEnv = process.env,
  home: string = homedir(),
): RootCategory {
  const found = resolveRootPolicy(env, home).find((category) => category.id === id);
  if (!found) {
    throw new Error(`unknown root category: ${id}`);
  }
  return found;
}
