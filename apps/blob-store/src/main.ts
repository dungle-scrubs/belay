import { startServer } from "@trevor/server-kit";
import { nodeMigrationFs, planLegacyMigration } from "@trevor/session/legacy-migration";
import { abbreviateHome } from "@trevor/session/node-paths";
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

const PORT = Number(process.env.BLOB_STORE_PORT ?? RESERVED_PORTS.blob);
const ROOT = blobStoreRoot();
const MAX_BYTES = Number(process.env.BLOB_STORE_MAX_BYTES ?? 25 * 1024 * 1024);

// Detect-only legacy migration (D-009): never changes the default; just nudges if importable
// ~/.trevor blob data is present, with a sanitized source path.
const legacyBlobs = planLegacyMigration(nodeMigrationFs).actions.find(
  (action) => action.artifact === "blobs",
);
if (legacyBlobs?.status === "migrate") {
  console.log(
    `[blob-store] legacy blob data detected at ${abbreviateHome(legacyBlobs.source)}; import it via migration or set BLOB_STORE_DIR`,
  );
}

startServer(createBlobServer(ROOT, MAX_BYTES), {
  port: PORT,
  onListen: (port) => {
    console.log(
      `[blob-store] listening on http://127.0.0.1:${port} (root: ${abbreviateHome(ROOT)})`,
    );
  },
});
