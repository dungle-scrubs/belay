import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Trevor's user-global base directory (D-081): the ONE source for every user-scoped path, mirroring
 * `WORKSPACE_ROOT`/`TREVOR_WORKSPACE` in tools/workspace.ts. Env-overridable via `TREVOR_HOME`; defaults
 * to `~/.trevorV2` (where the `dev:op`/`start:op` scripts already read `.env.op` from). Derive every
 * user-global path from this so the directory name lives in exactly one place.
 */
export const TREVOR_HOME = resolve(process.env.TREVOR_HOME ?? join(homedir(), ".trevorV2"));

/** The user-global `AGENTS.md`, the lowest-precedence (loaded-first) source of the eager context (D-080). */
export const USER_AGENTS_MD = join(TREVOR_HOME, "AGENTS.md");
