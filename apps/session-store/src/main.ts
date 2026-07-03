import { startStore } from "@trevor/server-kit";
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

const DB_PATH = sessionStoreDbPath();

startStore({
  name: "session-store",
  envPrefix: "SESSION_STORE",
  reservedPort: RESERVED_PORTS.store,
  dataLabel: "db",
  dataPath: DB_PATH,
  legacyArtifact: "sessions-db",
  legacyLabel: "session",
  legacyOverrideEnv: "SESSION_STORE_DB",
  build: () => createSessionStore(DB_PATH),
});
