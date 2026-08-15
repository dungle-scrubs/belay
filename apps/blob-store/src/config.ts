import { storagePathByName, type TrevorPathEnv } from "@belay/session/node-paths";

/**
 * The blob-store's identity, declared ONCE: the storage-inventory artifact its data lives under, the
 * env that overrides that path, and the labels `startStore` reports. Both this module's path resolver
 * and `main.ts`'s `startStore` options read it, so the artifact name and override-env name can't drift
 * between the resolver and the boot/migration nudge.
 */
export const BLOB_STORE = {
  name: "blob-store",
  envPrefix: "BLOB_STORE",
  dataLabel: "root",
  storageArtifact: "blobs",
  overrideEnv: "BLOB_STORE_DIR",
  legacyLabel: "blob",
} as const;

/**
 * Content-addressed blobs live in the STATE home, not the config dir. The default resolves through the
 * root policy's storage inventory (the `blobs` entry), so its placement is declared once. Override
 * with BLOB_STORE_DIR.
 */
export function blobStoreRoot(env: TrevorPathEnv = process.env, home?: string): string {
  return env[BLOB_STORE.overrideEnv] ?? storagePathByName(BLOB_STORE.storageArtifact, env, home);
}
