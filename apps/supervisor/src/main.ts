import { nodeFs, TREVOR_STATE_HOME } from "@trevor/launcher";
import { createService, startServer } from "@trevor/server-kit";
import {
  errorMessage,
  PRODUCER_IDS,
  SUPERVISOR_SESSION_ID,
  streamTransport,
  type TrevorEventInput,
  viewerIdentity,
} from "@trevor/session";
import { RESERVED_PORTS, serviceUrl } from "@trevor/session/ports";
import { handleSupervisorEvent, type SupervisorDeps } from "./dispatch";
import { pickProjectFolder } from "./folder-picker";
import { nodeLaunch } from "./launch-runner";
import { readRecents } from "./recents";

/**
 * The `trevor supervisor` daemon (plan 44.1): the one persistent local actor that can spawn a host on
 * demand. It (1) mounts a minimal `GET /health` server on the reserved supervisor port, so the
 * launcher's probe identifies it as ours and ensures it as the fourth shared service; and (2)
 * subscribes as a VIEWER to the reserved control session, dispatching each browser-published request
 * to `@trevor/launcher` and publishing the paired result back over the session log. Every browser
 * <-> supervisor exchange rides the session transport - there is no private IPC.
 *
 * All node IO (the real transport, the node launcher) is wired here and handed to the injectable
 * `handleSupervisorEvent`, so the dispatch logic is driven identically by the integration tests.
 */

const INSTANCE_ID = `supervisor-${process.pid}`;
const STORE_URL = process.env.SESSION_STORE_URL ?? serviceUrl("store");
const SUPERVISOR_PORT = Number(process.env.SUPERVISOR_PORT ?? RESERVED_PORTS.supervisor);

/** Best-effort structured log to stdout (captured by the launcher to `<state>/logs/supervisor.log`). */
function log(message: string, fields?: Record<string, unknown>): void {
  console.log(`[supervisor] ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
}

const transport = streamTransport(STORE_URL);

/** Publishes one result event on the control session, stamping the supervisor producer id. */
const emit = (event: TrevorEventInput): Promise<void> =>
  transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...event,
    producerId: PRODUCER_IDS.supervisor,
  });

const deps: SupervisorDeps = {
  emit,
  launch: nodeLaunch,
  pickFolder: pickProjectFolder,
  // The registry read lives under TREVOR_STATE_HOME (the launcher's projects.json), read through the
  // launcher's own map loader so there is one reader.
  listProjects: () => readRecents(nodeFs, TREVOR_STATE_HOME),
  selfProducerId: PRODUCER_IDS.supervisor,
  log,
};

/** Mounts the health server so `probeService` identifies the supervisor as ours (no domain routes). */
async function startHealthServer(): Promise<void> {
  const service = createService({ routes: [], corsMethods: "GET" });
  await startServer(service, {
    port: SUPERVISOR_PORT,
    onListen: (port) => log("health listening", { port }),
  });
}

/** Ensures the control session exists, retrying through a not-yet-ready store (the launcher spawns the
 *  supervisor and the store concurrently, so the store can lag the supervisor's first connect). */
async function ensureSessionReady(attempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await transport.ensureSession(SUPERVISOR_SESSION_ID);
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      log("store not ready; retrying", { attempt, error: errorMessage(error) });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Subscribes to the control session (replay-then-tail) with simple reconnect. */
function connect(): void {
  transport.connectSession({
    sessionId: SUPERVISOR_SESSION_ID,
    identity: viewerIdentity({
      displayName: "trevor-supervisor",
      instanceId: INSTANCE_ID,
      participantId: PRODUCER_IDS.supervisor,
    }),
    onEvent: (event) => void handleSupervisorEvent(event, deps),
    onStatus: (status) => {
      if (status === "open") {
        log("subscribed to control session", { session: SUPERVISOR_SESSION_ID });
      } else if (status === "closed") {
        log("control session closed; reconnecting", { ms: 1000 });
        setTimeout(connect, 1000);
      }
    },
  });
}

async function main(): Promise<void> {
  await startHealthServer();
  await ensureSessionReady();
  connect();
  log("started", { session: SUPERVISOR_SESSION_ID, store: STORE_URL });
}

main().catch((error: unknown) => {
  log("startup failed", { error: errorMessage(error) });
  process.exit(1);
});
