import { storagePathByName, type TrevorPathEnv } from "@trevor/session/node-paths";

/**
 * The session-log database lives in the STATE home, not the config dir. The default resolves through
 * the root policy's storage inventory (the `sessions-db` entry), so its placement is declared once.
 * Override with SESSION_STORE_DB.
 */
export function sessionStoreDbPath(env: TrevorPathEnv = process.env, home?: string): string {
  return env.SESSION_STORE_DB ?? storagePathByName("sessions-db", env, home);
}
