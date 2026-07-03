import { startStore } from "@trevor/server-kit";
import { RESERVED_PORTS } from "@trevor/session/ports";
import { blobStoreRoot } from "./config";
import { createBlobServer } from "./server";

/**
 * The blob-store entrypoint: reads config from the environment and binds the port. The
 * server itself (and its routes) lives in `./server` so tests can run it on an ephemeral
 * port against a throwaway directory. A content-addressed artifact store beside Richter
 * (D-028), reachable by every participant (host + browser) so a blob is as durable and
 * shareable as the session log it is referenced from.
 */

const ROOT = blobStoreRoot();
const MAX_BYTES = Number(process.env.BLOB_STORE_MAX_BYTES ?? 25 * 1024 * 1024);

startStore({
  name: "blob-store",
  envPrefix: "BLOB_STORE",
  reservedPort: RESERVED_PORTS.blob,
  dataLabel: "root",
  dataPath: ROOT,
  legacyArtifact: "blobs",
  legacyLabel: "blob",
  legacyOverrideEnv: "BLOB_STORE_DIR",
  build: () => createBlobServer(ROOT, MAX_BYTES),
});
