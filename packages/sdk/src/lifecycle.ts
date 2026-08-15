import { events, type SessionSummary, sessionsForProject } from "@belay/session";
import type { TrevorClient } from "./client";

/**
 * The SDK session-lifecycle workflow (plan 28 M6). The PURE selection/resolution logic - which sessions
 * a `list` shows and where an `open <id>` should launch - lives here as the single source, so the CLI
 * and any other headless consumer cannot drift from each other (the CLI re-exports these). Archive /
 * unarchive publish the durable `session.archived` marker through the client. The SDK deliberately does
 * NOT own stop/kill (OS signals) or process-ownership records - those stay in `apps/belay-cli`; the SDK
 * only reaches protocol-safe lifecycle state (M6 REFACTOR). `cancel` (a run control) is distinct again:
 * it lives in the prompt workflow, not here.
 */

export interface ListSessionsOptions {
  /** Scope to a project (the inventory's `project`, a workspace basename); null/absent lists all. */
  readonly project?: string | null;
  /** List archived sessions instead of active ones (default false). */
  readonly archived?: boolean;
  /** An optional abort signal for the underlying inventory fetch. */
  readonly signal?: AbortSignal;
}

/**
 * Current-project sessions, newest first: active by default, or archived only with `archived: true`. A
 * thin CLI-facing alias over `@belay/session`'s {@link sessionsForProject} (the one owner of the scope +
 * recency rule), so the headless `list` can't drift from the web sidebar.
 */
export function selectSessions(
  summaries: readonly SessionSummary[],
  project: string | null | undefined,
  opts: { readonly archived: boolean },
): SessionSummary[] {
  return sessionsForProject(summaries, project, opts);
}

/** Fetches the inventory and returns the project-scoped, active-or-archived selection. */
export function listSessions(
  client: TrevorClient,
  options: ListSessionsOptions = {},
): Promise<readonly SessionSummary[]> {
  return client.sessionOp("fetchInventory", undefined, async () => {
    const all = await client.transport.fetchInventory(options.signal);
    return selectSessions(all, options.project ?? null, { archived: options.archived ?? false });
  });
}

/** Publishes the durable `session.archived` marker (true = archive, false = unarchive). */
function publishArchived(
  client: TrevorClient,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  return client.publishEvent(
    sessionId,
    events.sessionArchived({ archived }),
    archived ? "archive" : "unarchive",
  );
}

/** Archives a session (hides it from default views; keeps its log). */
export function archiveSession(client: TrevorClient, sessionId: string): Promise<void> {
  return publishArchived(client, sessionId, true);
}

/** Unarchives a session. */
export function unarchiveSession(client: TrevorClient, sessionId: string): Promise<void> {
  return publishArchived(client, sessionId, false);
}

/** Where `open <session>` should launch: the session id + its absolute workspace root. */
export interface OpenTarget {
  readonly sessionId: string;
  readonly root: string;
}

/** Expands a leading `~` in an abbreviated path against `home` (e.g. `~/dev/x` -> `<home>/dev/x`). */
export function expandHome(dir: string, home: string): string {
  if (dir === "~") {
    return home;
  }
  return dir.startsWith("~/") ? home + dir.slice(1) : dir;
}

/**
 * Resolves `open <session>` against an inventory: the requested session's absolute workspace root (so a
 * launcher can spawn-or-attach a host pointed at it), or a clear message when the id is missing, unknown,
 * deleted, archived, or has no recorded workspace. Pure over the injected inventory + home, so it is
 * unit-tested without a store. The launcher (CLI) then drives the real spawn.
 */
export function resolveOpenTarget(
  summaries: readonly SessionSummary[],
  sessionId: string,
  home: string,
): OpenTarget | { readonly error: string } {
  if (!sessionId) {
    return { error: "usage: belay open <session>" };
  }
  const summary = summaries.find((s) => s.sessionId === sessionId);
  if (!summary) {
    return {
      error: `No session "${sessionId}" found. Run \`belay list\` to see this project's sessions.`,
    };
  }
  if (summary.deleted) {
    return { error: `Session "${sessionId}" was deleted.` };
  }
  if (summary.archived) {
    return {
      error: `Session "${sessionId}" is archived. Run \`belay unarchive ${sessionId}\` first, then open it.`,
    };
  }
  const dir = summary.workspace ?? summary.cwd;
  if (!dir) {
    return {
      error: `Session "${sessionId}" has no recorded workspace, so it can't be opened directly.`,
    };
  }
  return { sessionId, root: expandHome(dir, home) };
}
