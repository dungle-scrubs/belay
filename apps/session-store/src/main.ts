import { startStore } from "@belay/server-kit";
import { RESERVED_PORTS } from "@belay/session/ports";
import { SESSION_STORE, sessionStoreDbPath } from "./config";
import { createSessionStore } from "./server";

/**
 * The local session-store entrypoint: reads config from the environment and binds
 * the port. The server itself (and its SQLite log) lives in `./server` so tests can
 * run it on an ephemeral port against a throwaway database. This is the default,
 * Tether-free durable substrate for local-mode sessions; set TETHER_URL on the
 * host/web to opt into Tether instead.
 */

const DB_PATH = sessionStoreDbPath();

startStore({
  name: SESSION_STORE.name,
  envPrefix: SESSION_STORE.envPrefix,
  reservedPort: RESERVED_PORTS.store,
  dataLabel: SESSION_STORE.dataLabel,
  dataPath: DB_PATH,
  legacyArtifact: SESSION_STORE.storageArtifact,
  legacyLabel: SESSION_STORE.legacyLabel,
  legacyOverrideEnv: SESSION_STORE.overrideEnv,
  build: () => createSessionStore(DB_PATH),
});
