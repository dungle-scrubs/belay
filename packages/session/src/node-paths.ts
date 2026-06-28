import { homedir } from "node:os";
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
