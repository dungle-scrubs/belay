import {
  decodeTrevorEvent,
  errorMessage,
  events,
  isAnswerableProducer,
  projectSessionId,
  type SessionEvent,
  type SessionLaunchOkStatus,
  type SupervisorProject,
  type TrevorEventInput,
} from "@trevor/session";

/**
 * The supervisor's request dispatcher (plan 44.1). It decodes a control-session event, ignores its own
 * echoed results and any non-request event, and answers each browser-published request with its paired
 * result over the SESSION LOG - never a private channel (supervision is not communication). Its
 * collaborators (publishing, host launch) are INJECTED, so the daemon wiring in `main.ts` (real
 * transport + node launcher) and the integration tests (a fake launcher over a real store) drive the
 * exact same dispatch.
 *
 * It owns one handler per request type: launch, folder pick, and recent projects.
 */

/** The collaborators the dispatcher needs, all injected so the handler stays free of node IO. */
export interface SupervisorDeps {
  /** Publishes a result event on the control session (the caller stamps the supervisor producer id). */
  readonly emit: (event: TrevorEventInput) => Promise<void>;
  /** The launcher core: spawn-or-reuse a host for a resolved session; resolves the browser-facing
   *  outcome (`launched` = fresh/replaced host, `reused` = an already-live host). A rejection is
   *  reported as a `failed` result rather than crashing the daemon. */
  readonly launch: (input: {
    readonly sessionId: string;
    readonly root: string;
  }) => Promise<SessionLaunchOkStatus>;
  /** Pops the native folder picker (local + best-effort); resolves the chosen path or `cancelled`. */
  readonly pickFolder: () => Promise<{ readonly path?: string; readonly cancelled: boolean }>;
  /** The launcher's recent project roots (`projects.json`), recency-sorted; empty when absent. */
  readonly listProjects: () => readonly SupervisorProject[];
  /** This supervisor's producer id, so it never acts on its own echoed results (self-echo suppression). */
  readonly selfProducerId: string;
  /** Structured diagnostics sink; a no-op by default. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Decodes one control-session event and dispatches it to the matching request handler. */
export async function handleSupervisorEvent(
  event: SessionEvent,
  deps: SupervisorDeps,
): Promise<void> {
  // Self-echo suppression: act only on requests from ANOTHER producer (the browser), never on the
  // results this supervisor itself published. This is the same gate the host uses.
  if (!isAnswerableProducer(event.producerId, deps.selfProducerId)) {
    return;
  }
  const decoded = decodeTrevorEvent(event);
  if (!decoded) {
    return;
  }
  switch (decoded.type) {
    case "session.launch.requested":
      await handleLaunch(decoded.requestId, decoded.root, deps);
      break;
    case "folder.pick.requested":
      await handleFolderPick(decoded.requestId, deps);
      break;
    case "projects.list.requested":
      await handleProjectsList(decoded.requestId, deps);
      break;
    default:
      // Result events and every other kind are ignored (the host owns those; we own the requests).
      break;
  }
}

/**
 * Resolves the deterministic session id for `root`, drives the injected launcher, and publishes the
 * paired `session.launch.result`. A launcher failure (unresolvable/nonexistent root, spawn denied) is
 * caught and surfaced as a structured `failed` result on the control session - never a silent drop.
 */
async function handleLaunch(requestId: string, root: string, deps: SupervisorDeps): Promise<void> {
  const sessionId = projectSessionId(root);
  try {
    const status = await deps.launch({ sessionId, root });
    deps.log?.("launch dispatched", { requestId, root, sessionId, status });
    await deps.emit(events.sessionLaunchResult({ requestId, sessionId, status }));
  } catch (error) {
    const message = errorMessage(error);
    deps.log?.("launch failed", { requestId, root, sessionId, error: message });
    await deps.emit(
      events.sessionLaunchResult({ requestId, sessionId, status: "failed", error: message }),
    );
  }
}

/** Pops the native folder picker and publishes the paired `folder.pick.result` (path or cancelled). */
async function handleFolderPick(requestId: string, deps: SupervisorDeps): Promise<void> {
  const outcome = await deps.pickFolder();
  deps.log?.("folder pick", { requestId, cancelled: outcome.cancelled });
  await deps.emit(
    events.folderPickResult({ requestId, cancelled: outcome.cancelled, path: outcome.path }),
  );
}

/** Reads the launcher's recent projects (recency-sorted) and publishes `projects.list.result`. */
async function handleProjectsList(requestId: string, deps: SupervisorDeps): Promise<void> {
  const projects = deps.listProjects();
  deps.log?.("projects list", { requestId, count: projects.length });
  await deps.emit(events.projectsListResult({ requestId, projects }));
}
