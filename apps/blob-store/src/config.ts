import { join } from "node:path";
import { resolveTrevorStateHome, type TrevorPathEnv } from "@trevor/session/node-paths";

/** Content-addressed blobs live in the STATE home, not the config dir. Override with BLOB_STORE_DIR. */
export function blobStoreRoot(env: TrevorPathEnv = process.env, home?: string): string {
  return env.BLOB_STORE_DIR ?? join(resolveTrevorStateHome(env, home), "blobs");
}
