import { join } from "node:path";
import { resolveTrevorHome, type TrevorPathEnv } from "@trevor/session/node-paths";

export function blobStoreRoot(env: TrevorPathEnv = process.env, home?: string): string {
  return env.BLOB_STORE_DIR ?? join(resolveTrevorHome(env, home), "blobs");
}
