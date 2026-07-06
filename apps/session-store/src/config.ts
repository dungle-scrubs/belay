import { storagePathByName, type TrevorPathEnv } from "@trevor/session/node-paths";

/**
 * The session-store's identity, declared ONCE: the storage-inventory artifact its DB lives under, the
 * env that overrides that path, and the labels `startStore` reports. Both this module's path resolver
 * and `main.ts`'s `startStore` options read it, so the artifact name and override-env name can't drift
 * between the resolver and the boot/migration nudge.
 */
export const SESSION_STORE = {
  name: "session-store",
  envPrefix: "SESSION_STORE",
  dataLabel: "db",
  storageArtifact: "sessions-db",
  overrideEnv: "SESSION_STORE_DB",
  legacyLabel: "session",
} as const;

/**
 * The session-log database lives in the STATE home, not the config dir. The default resolves through
 * the root policy's storage inventory (the `sessions-db` entry), so its placement is declared once.
 * Override with SESSION_STORE_DB.
 */
export function sessionStoreDbPath(env: TrevorPathEnv = process.env, home?: string): string {
  return (
    env[SESSION_STORE.overrideEnv] ?? storagePathByName(SESSION_STORE.storageArtifact, env, home)
  );
}
