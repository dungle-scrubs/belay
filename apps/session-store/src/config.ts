import { join } from "node:path";
import { resolveTrevorHome, type TrevorPathEnv } from "@trevor/session/node-paths";

export function sessionStoreDbPath(env: TrevorPathEnv = process.env, home?: string): string {
  return env.SESSION_STORE_DB ?? join(resolveTrevorHome(env, home), "sessions.db");
}
