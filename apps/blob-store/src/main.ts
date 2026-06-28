import { homedir } from "node:os";
import { join } from "node:path";
import { RESERVED_PORTS } from "@trevor/session/ports";
import { createBlobServer } from "./server";

/**
 * The blob-store entrypoint: reads config from the environment and binds the port. The
 * server itself (and its routes) lives in `./server` so tests can run it on an ephemeral
 * port against a throwaway directory. A content-addressed artifact store beside Richter
 * (D-028), reachable by every participant (host + browser) so a blob is as durable and
 * shareable as the session log it is referenced from.
 */

const PORT = Number(process.env.BLOB_STORE_PORT ?? RESERVED_PORTS.blob);
const ROOT = process.env.BLOB_STORE_DIR ?? join(homedir(), ".trevor", "blobs");
const MAX_BYTES = Number(process.env.BLOB_STORE_MAX_BYTES ?? 25 * 1024 * 1024);

createBlobServer(ROOT, MAX_BYTES).listen(PORT, () => {
  console.log(`[blob-store] listening on http://127.0.0.1:${PORT} (root: ${ROOT})`);
});
