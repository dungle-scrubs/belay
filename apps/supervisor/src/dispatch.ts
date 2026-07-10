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
  /** Publishes an event on an ARBITRARY session (plan 58 M4): used to stamp a `session.project`
   *  marker on a freshly-minted project-scoped session before the host launches. The caller stamps
   *  the supervisor producer id. Falls back to `emit` (control session) when not wired. */
  readonly publishToSession?: (sessionId: string, event: TrevorEventInput) => Promise<void>;
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
  /**
   * The canonical project registry (plan 58): path-keyed project metadata with CRUD over an
   * injected fs + state home. When absent the dispatcher falls back to `listProjects` for
   * `projects.list.requested` (backward compat with the pre-registry wiring).
   */
  readonly projectRegistry?: {
    add: (path: string, now: string) => { path: string; displayName: string };
    rename: (
      path: string,
      displayName: string,
      now: string,
    ) => { path: string; displayName: string } | null;
    setCollapsed: (
      path: string,
      collapsed: boolean,
      now: string,
    ) => { path: string; collapsed: boolean } | null;
    remove: (path: string) => boolean;
    list: () => readonly {
      path: string;
      displayPath: string;
      displayName: string;
      collapsed: boolean;
      createdAt: string;
      updatedAt: string;
    }[];
  };
  /** Whether a project root still exists on disk (plan 58.8). Wired to the launcher's
   *  directory-existence check - the SAME semantics the launch missing-root gate uses - so the
   *  list's `missing` marking and the launch failure can never disagree. Async so a hung stat (a
   *  stale network mount) never blocks the dispatch loop. When absent, records are reported
   *  unmarked (legacy wiring). */
  readonly rootExists?: (path: string) => boolean | Promise<boolean>;
  /** ISO timestamp source for registry `updatedAt` stamps. */
  readonly now?: () => string;
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
      await handleLaunch(
        decoded.requestId,
        decoded.root,
        deps,
        decoded.sessionId,
        decoded.projectPath,
      );
      break;
    case "folder.pick.requested":
      await handleFolderPick(decoded.requestId, deps);
      break;
    case "projects.list.requested":
      await handleProjectsList(decoded.requestId, deps);
      break;
    case "project.add.requested":
      await handleProjectAdd(decoded.requestId, deps);
      break;
    case "project.rename.requested":
      await handleProjectRename(decoded.requestId, decoded.path, decoded.displayName, deps);
      break;
    case "project.collapse.requested":
      await handleProjectCollapse(decoded.requestId, decoded.path, decoded.collapsed, deps);
      break;
    case "project.remove.requested":
      await handleProjectRemove(decoded.requestId, decoded.path, deps);
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
async function handleLaunch(
  requestId: string,
  root: string,
  deps: SupervisorDeps,
  sessionIdOverride?: string,
  projectPath?: string,
): Promise<void> {
  const sessionId = sessionIdOverride ?? projectSessionId(root);
  try {
    // Plan 58 M4: a fresh project-scoped session gets a `session.project` marker BEFORE the host
    // launches, so the inventory can group it by project from the very first event. Touch the
    // registry too so the project surfaces in the sidebar. Both are best-effort: a missing
    // publishToSession or registry degrades to the legacy bare-root launch.
    if (projectPath) {
      if (deps.publishToSession) {
        await deps.publishToSession(sessionId, events.sessionProject({ path: projectPath }));
      }
      if (deps.projectRegistry) {
        const now = deps.now?.() ?? new Date().toISOString();
        deps.projectRegistry.add(projectPath, now);
      }
    }
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

/**
 * Reads the project list and publishes `projects.list.result`. Prefers the canonical registry
 * (`deps.projectRegistry.list()`, plan 58) when wired; falls back to the legacy `listProjects`
 * reader for a supervisor still on the pre-registry wiring. When `rootExists` is wired, each
 * record is stat-marked `missing` (plan 58.8) - a passive signal riding a read the sidebar
 * already performs; records are NEVER auto-pruned here.
 */
async function handleProjectsList(requestId: string, deps: SupervisorDeps): Promise<void> {
  const base = deps.projectRegistry
    ? deps.projectRegistry.list().map((r) => ({
        root: r.path,
        sessionId: projectSessionId(r.path),
        updatedAt: r.updatedAt,
      }))
    : deps.listProjects();
  const rootExists = deps.rootExists;
  // Stats run in parallel: one slow root (a hung mount) delays only this response, not N-fold.
  const projects = rootExists
    ? await Promise.all(base.map(async (p) => ({ ...p, missing: !(await rootExists(p.root)) })))
    : base;
  deps.log?.("projects list", { requestId, count: projects.length });
  await deps.emit(events.projectsListResult({ requestId, projects }));
}

/**
 * Pops the folder picker and, on a chosen path, adds the project to the registry. Publishes
 * `project.add.result` with the path/displayName, or `cancelled: true` when the picker is
 * dismissed/unavailable.
 */
async function handleProjectAdd(requestId: string, deps: SupervisorDeps): Promise<void> {
  const outcome = await deps.pickFolder();
  if (outcome.cancelled || !outcome.path) {
    deps.log?.("project add cancelled", { requestId });
    await deps.emit(events.projectAddResult({ requestId, cancelled: true }));
    return;
  }
  if (!deps.projectRegistry) {
    await deps.emit(
      events.projectAddResult({
        requestId,
        cancelled: false,
        error: "project registry not available",
      }),
    );
    return;
  }
  const now = deps.now?.() ?? new Date().toISOString();
  try {
    const result = deps.projectRegistry.add(outcome.path, now);
    deps.log?.("project add", { requestId, path: result.path, displayName: result.displayName });
    await deps.emit(
      events.projectAddResult({
        requestId,
        path: result.path,
        displayName: result.displayName,
        cancelled: false,
      }),
    );
  } catch (error) {
    const message = errorMessage(error);
    deps.log?.("project add failed", { requestId, path: outcome.path, error: message });
    await deps.emit(events.projectAddResult({ requestId, cancelled: false, error: message }));
  }
}

/** Renames a project in the registry and publishes `project.rename.result`. */
async function handleProjectRename(
  requestId: string,
  path: string,
  displayName: string,
  deps: SupervisorDeps,
): Promise<void> {
  if (!deps.projectRegistry) {
    await deps.emit(
      events.projectRenameResult({ requestId, path, error: "project registry not available" }),
    );
    return;
  }
  const now = deps.now?.() ?? new Date().toISOString();
  try {
    const result = deps.projectRegistry.rename(path, displayName, now);
    if (!result) {
      deps.log?.("project rename not found", { requestId, path });
      await deps.emit(events.projectRenameResult({ requestId, path, error: "project not found" }));
      return;
    }
    deps.log?.("project rename", { requestId, path, displayName: result.displayName });
    await deps.emit(
      events.projectRenameResult({
        requestId,
        path: result.path,
        displayName: result.displayName,
      }),
    );
  } catch (error) {
    const message = errorMessage(error);
    deps.log?.("project rename failed", { requestId, path, error: message });
    await deps.emit(events.projectRenameResult({ requestId, path, error: message }));
  }
}

/** Sets the collapsed state of a project and publishes `project.collapse.result`. */
async function handleProjectCollapse(
  requestId: string,
  path: string,
  collapsed: boolean,
  deps: SupervisorDeps,
): Promise<void> {
  if (!deps.projectRegistry) {
    await deps.emit(
      events.projectCollapseResult({
        requestId,
        path,
        collapsed,
        error: "project registry not available",
      }),
    );
    return;
  }
  const now = deps.now?.() ?? new Date().toISOString();
  try {
    const result = deps.projectRegistry.setCollapsed(path, collapsed, now);
    if (!result) {
      deps.log?.("project collapse not found", { requestId, path });
      await deps.emit(
        events.projectCollapseResult({ requestId, path, collapsed, error: "project not found" }),
      );
      return;
    }
    deps.log?.("project collapse", { requestId, path, collapsed: result.collapsed });
    await deps.emit(
      events.projectCollapseResult({
        requestId,
        path: result.path,
        collapsed: result.collapsed,
      }),
    );
  } catch (error) {
    const message = errorMessage(error);
    deps.log?.("project collapse failed", { requestId, path, error: message });
    await deps.emit(events.projectCollapseResult({ requestId, path, collapsed, error: message }));
  }
}

/** Removes a project from the registry and publishes `project.remove.result`. */
async function handleProjectRemove(
  requestId: string,
  path: string,
  deps: SupervisorDeps,
): Promise<void> {
  if (!deps.projectRegistry) {
    await deps.emit(
      events.projectRemoveResult({
        requestId,
        path,
        removed: false,
        error: "project registry not available",
      }),
    );
    return;
  }
  try {
    const removed = deps.projectRegistry.remove(path);
    if (!removed) {
      deps.log?.("project remove not found", { requestId, path });
      await deps.emit(
        events.projectRemoveResult({ requestId, path, removed: false, error: "project not found" }),
      );
      return;
    }
    deps.log?.("project remove", { requestId, path });
    await deps.emit(events.projectRemoveResult({ requestId, path, removed: true }));
  } catch (error) {
    const message = errorMessage(error);
    deps.log?.("project remove failed", { requestId, path, error: message });
    await deps.emit(
      events.projectRemoveResult({ requestId, path, removed: false, error: message }),
    );
  }
}
