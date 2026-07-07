import {
  addProject,
  listProjects,
  nodeFs,
  removeProject,
  renameProject,
  setCollapsed,
  TREVOR_HOME,
  TREVOR_STATE_HOME,
} from "@trevor/launcher";
import { createService, startServer } from "@trevor/server-kit";
import {
  errorMessage,
  PRODUCER_IDS,
  SUPERVISOR_SESSION_ID,
  streamTransport,
  type TrevorEventInput,
} from "@trevor/session";
import { RESERVED_PORTS, serviceUrl } from "@trevor/session/ports";
import { createTelemetrySink } from "@trevor/session/telemetry-file-sink";
import type { SupervisorDeps } from "./dispatch";
import { pickProjectFolder } from "./folder-picker";
import { nodeLaunch } from "./launch-runner";
import { readRecents } from "./recents";
import { subscribeControlSession } from "./subscribe";
import { startStoreWatchdog } from "./watchdog";

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
  // The canonical project registry (plan 58): path-keyed metadata with CRUD over the real node fs
  // + state home. `add` passes TREVOR_HOME so `displayPath` is home-abbreviated.
  projectRegistry: {
    add: (path, now) => {
      const r = addProject(nodeFs, TREVOR_STATE_HOME, path, now, TREVOR_HOME);
      return { path: r.path, displayName: r.displayName };
    },
    rename: (path, displayName, now) => {
      const r = renameProject(nodeFs, TREVOR_STATE_HOME, path, displayName, now);
      return r ? { path: r.path, displayName: r.displayName } : null;
    },
    setCollapsed: (path, collapsed, now) => {
      const r = setCollapsed(nodeFs, TREVOR_STATE_HOME, path, collapsed, now);
      return r ? { path: r.path, collapsed: r.collapsed } : null;
    },
    remove: (path) => removeProject(nodeFs, TREVOR_STATE_HOME, path),
    list: () => listProjects(nodeFs, TREVOR_STATE_HOME),
  },
  now: () => new Date().toISOString(),
  // MUST be the same identity `emit` stamps, or self-echo suppression breaks (the supervisor would act
  // on its own published results).
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

async function main(): Promise<void> {
  await startHealthServer();
  // The watchdog starts BEFORE the store handshake: it must already be polling while
  // `ensureSessionReady` waits on a store that may be the very wedge it exists to break.
  startStoreWatchdog({ storeUrl: STORE_URL, telemetry: createTelemetrySink("supervisor"), log });
  await ensureSessionReady();
  subscribeControlSession(transport, deps, { instanceId: INSTANCE_ID, log });
  log("started", { session: SUPERVISOR_SESSION_ID, store: STORE_URL });
}

main().catch((error: unknown) => {
  log("startup failed", { error: errorMessage(error) });
  process.exit(1);
});
