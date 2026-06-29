import { startServer } from "@trevor/server-kit";
import { nodeMigrationFs, planLegacyMigration } from "@trevor/session/legacy-migration";
import { abbreviateHome } from "@trevor/session/node-paths";
import { RESERVED_PORTS } from "@trevor/session/ports";
import { sessionStoreDbPath } from "./config";
import { createSessionStore } from "./server";

/**
 * The local session-store entrypoint: reads config from the environment and binds
 * the port. The server itself (and its SQLite log) lives in `./server` so tests can
 * run it on an ephemeral port against a throwaway database. This is the default,
 * Richter-free durable substrate for local-mode sessions; set RICHTER_URL on the
 * host/web to opt into Richter instead.
 */

const PORT = Number(process.env.SESSION_STORE_PORT ?? RESERVED_PORTS.store);
const DB_PATH = sessionStoreDbPath();

// Detect-only legacy migration (D-009): never changes the default; just nudges if importable
// ~/.trevor session data is present, with a sanitized source path.
const legacyDb = planLegacyMigration(nodeMigrationFs).actions.find(
  (action) => action.artifact === "sessions-db",
);
if (legacyDb?.status === "migrate") {
  console.log(
    `[session-store] legacy session data detected at ${abbreviateHome(legacyDb.source)}; import it via migration or set SESSION_STORE_DB`,
  );
}

startServer(createSessionStore(DB_PATH), {
  port: PORT,
  onListen: (port) => {
    console.log(
      `[session-store] listening on http://127.0.0.1:${port} (db: ${abbreviateHome(DB_PATH)})`,
    );
  },
});
