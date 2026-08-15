import { startStore } from "@belay/server-kit";
import { RESERVED_PORTS } from "@belay/session/ports";
import { BLOB_STORE, blobStoreRoot } from "./config";
import { createBlobServer } from "./server";

/**
 * The blob-store entrypoint: reads config from the environment and binds the port. The
 * server itself (and its routes) lives in `./server` so tests can run it on an ephemeral
 * port against a throwaway directory. A content-addressed artifact store beside Tether
 * (D-028), reachable by every participant (host + browser) so a blob is as durable and
 * shareable as the session log it is referenced from.
 */

const ROOT = blobStoreRoot();
const MAX_BYTES = Number(process.env.BLOB_STORE_MAX_BYTES ?? 25 * 1024 * 1024);

startStore({
  name: BLOB_STORE.name,
  envPrefix: BLOB_STORE.envPrefix,
  reservedPort: RESERVED_PORTS.blob,
  dataLabel: BLOB_STORE.dataLabel,
  dataPath: ROOT,
  legacyArtifact: BLOB_STORE.storageArtifact,
  legacyLabel: BLOB_STORE.legacyLabel,
  legacyOverrideEnv: BLOB_STORE.overrideEnv,
  build: () => createBlobServer(ROOT, MAX_BYTES),
});
