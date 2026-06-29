import type {
  SessionEvent,
  SessionIdentity,
  SessionSummary,
  SessionTransport,
} from "@trevor/session";
import { warn } from "../../log";
import { msg } from "../../messages";
import { engineDiagnostic, type SiblingRead, type SiblingSession } from "./engine";
import type { RecallDiagnostic, RecallSessionRef } from "./types";

/**
 * The host-side sibling reader (D-044): enumerates the OTHER durable sessions for the current
 * project and reads each one's event log read-only, without ever loading it into the active
 * session. It speaks the same `/sessions` inventory + replay-then-tail stream the resume chooser
 * does, so "same project" stays the launcher/resume project identity, not a second notion.
 *
 * Every failure mode - inventory down, a session that won't read, a read that times out - becomes
 * a visible {@link RecallDiagnostic} rather than a silent gap, so a recall result can always say
 * what it could not reach.
 */

/** Most recent sibling sessions to read per recall (bounds sockets + work; the rest are skipped). */
const MAX_SIBLINGS = 12;
/** Per-session read timeout: a slow/wedged session degrades to a diagnostic, not a hung recall. */
const READ_TIMEOUT_MS = 4_000;

export interface SiblingReaderOptions {
  readonly transport: SessionTransport;
  /** A read-only participant identity for the sibling streams. */
  readonly identity: SessionIdentity;
  readonly currentSessionId: string;
  /** Canonical workspace path of the current session (preferred same-project key). */
  readonly currentWorkspace: string | null;
  /** Project basename fallback when a session has no announced workspace. */
  readonly currentProject: string | null;
}

/** Reads the durable-store inventory over the transport seam; returns null on any failure so recall
 *  degrades to a diagnostic rather than throwing. */
async function readInventory(
  transport: SessionTransport,
): Promise<readonly SessionSummary[] | null> {
  try {
    return await transport.fetchInventory();
  } catch (error) {
    warn("recall", "inventory fetch failed", { error: msg(error) });
    return null;
  }
}

/** Whether a summary belongs to the same project as the current session (canonical root first). */
function sameProject(summary: SessionSummary, opts: SiblingReaderOptions): boolean {
  if (opts.currentWorkspace && summary.workspace) {
    return summary.workspace === opts.currentWorkspace;
  }
  return opts.currentProject != null && summary.project === opts.currentProject;
}

/** Reads one session's full durable log over the transport (replay then close), with a timeout. */
function readSessionLog(opts: SiblingReaderOptions, sessionId: string): Promise<SessionEvent[]> {
  return new Promise<SessionEvent[]>((resolve, reject) => {
    const collected: SessionEvent[] = [];
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      connection.close();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error("read timed out"))),
      READ_TIMEOUT_MS,
    );

    const connection = opts.transport.connectSession({
      sessionId,
      identity: opts.identity,
      afterSeq: 0,
      onEvent: (event) => collected.push(event),
      onReplayComplete: () => finish(() => resolve(collected)),
      onStatus: (status) => {
        if (status === "closed" && !settled) {
          finish(() => reject(new Error("socket closed before replay completed")));
        }
      },
    });
  });
}

/** A stable recall session ref for a sibling, labeled by its inventory title. */
function refOf(summary: SessionSummary): RecallSessionRef {
  return {
    sessionId: summary.sessionId,
    label: summary.title,
    project: summary.project,
    origin: "sibling-session",
  };
}

/**
 * Builds the `siblings()` reader the recall engine depends on. Enumerates same-project sessions
 * (excluding the current one), reads the most recent {@link MAX_SIBLINGS}, and turns every problem
 * into a diagnostic. A `stale` host (a session that announced a host but has none live) is read
 * anyway - its durable log is still there - but flagged, matching the "stale, not silent" rule.
 */
export function createSiblingReader(opts: SiblingReaderOptions): () => Promise<SiblingRead> {
  return async () => {
    const inventory = await readInventory(opts.transport);
    if (inventory === null) {
      return {
        sessions: [],
        diagnostics: [engineDiagnostic("unreadable", "session inventory unavailable")],
      };
    }

    const candidates = inventory
      .filter((summary) => summary.sessionId !== opts.currentSessionId)
      .filter((summary) => sameProject(summary, opts))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const diagnostics: RecallDiagnostic[] = [];
    const chosen = candidates.slice(0, MAX_SIBLINGS);
    for (const skipped of candidates.slice(MAX_SIBLINGS)) {
      diagnostics.push({
        sessionId: skipped.sessionId,
        kind: "skipped",
        detail: "beyond the per-recall sibling cap",
      });
    }

    const sessions: SiblingSession[] = [];
    for (const summary of chosen) {
      try {
        const eventsRead = await readSessionLog(opts, summary.sessionId);
        if (eventsRead.length === 0) {
          diagnostics.push({
            sessionId: summary.sessionId,
            kind: "empty",
            detail: "session has no events",
          });
          continue;
        }
        sessions.push({ session: refOf(summary), events: eventsRead });
        if (summary.host === "stale") {
          diagnostics.push({
            sessionId: summary.sessionId,
            kind: "stale",
            detail: "host announced but not live; read from the durable log",
          });
        }
      } catch (error) {
        diagnostics.push({
          sessionId: summary.sessionId,
          kind: "unreadable",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { sessions, diagnostics };
  };
}
