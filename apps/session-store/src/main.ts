import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "@trevor/server-kit";
import { RESERVED_PORTS } from "@trevor/session/ports";
import { createSessionStore } from "./server";

/**
 * The local session-store entrypoint: reads config from the environment and binds
 * the port. The server itself (and its SQLite log) lives in `./server` so tests can
 * run it on an ephemeral port against a throwaway database. This is the default,
 * Richter-free durable substrate for local-mode sessions; set RICHTER_URL on the
 * host/web to opt into Richter instead.
 */

const PORT = Number(process.env.SESSION_STORE_PORT ?? RESERVED_PORTS.store);
const DB_PATH = process.env.SESSION_STORE_DB ?? join(homedir(), ".trevor", "sessions.db");

startServer(createSessionStore(DB_PATH), {
  port: PORT,
  onListen: (port) => {
    console.log(`[session-store] listening on http://127.0.0.1:${port} (db: ${DB_PATH})`);
  },
});
