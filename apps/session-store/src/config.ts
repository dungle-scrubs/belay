import { join } from "node:path";
import { resolveTrevorStateHome, type TrevorPathEnv } from "@trevor/session/node-paths";

/** The session-log database lives in the STATE home, not the config dir. Override with SESSION_STORE_DB. */
export function sessionStoreDbPath(env: TrevorPathEnv = process.env, home?: string): string {
  return env.SESSION_STORE_DB ?? join(resolveTrevorStateHome(env, home), "sessions.db");
}
