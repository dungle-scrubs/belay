import { storagePathByName, type TrevorPathEnv } from "@trevor/session/node-paths";

/**
 * Content-addressed blobs live in the STATE home, not the config dir. The default resolves through the
 * root policy's storage inventory (the `blobs` entry), so its placement is declared once. Override
 * with BLOB_STORE_DIR.
 */
export function blobStoreRoot(env: TrevorPathEnv = process.env, home?: string): string {
  return env.BLOB_STORE_DIR ?? storagePathByName("blobs", env, home);
}
