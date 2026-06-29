import {
  type ArtifactRef,
  type ConnectionStatus,
  type HostPresence,
  type ModelRef,
  type PastePayload,
  PRODUCER_IDS,
  type ProviderQuestionAnswer,
  type PublishInput,
  RUNTIME_KIND,
  type SessionConnection,
  type SessionEvent,
  type SessionIdentity,
  type SessionTransport,
  events as sessionEvents,
  streamTransport,
  type TrevorEventInput,
} from "@trevor/session";
import { useCallback, useEffect, useMemo, useState } from "react";

export type { ConnectionStatus, HostPresence };

/**
 * The web session boundary: the transport binding (backend selection + this tab's identity) plus the
 * two React hooks the app subscribes through. Receiving and acting are split (D-018):
 *   - `useSession` accumulates the replay-then-tail event stream into state (read side),
 *   - `useSessionActions` publishes user intents - prompt / cancel / command / editor-open (write side).
 * Backend selection is a single `streamTransport(url)` call - Richter speaks the same `/sessions`
 * REST + WS contract as the local store, so it is just that URL, not a separate adapter. The stream
 * URL, decode loop, and REST calls live in `@trevor/session`, so host and browser can never drift on
 * the protocol.
 */

// Backend selection: by default the browser talks same-origin to the local session-store, which the
// Vite dev proxy forwards /sessions (REST + WS) to (no CORS). Set VITE_RICHTER_URL to point the same
// transport at a Richter durable substrate instead (a Richter that serves CORS directly).
const RICHTER_URL = import.meta.env.VITE_RICHTER_URL;
const transport = RICHTER_URL
  ? streamTransport(RICHTER_URL)
  : streamTransport(window.location.origin);
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 2_000;

// Identity is per-tab and persisted in sessionStorage, so a page reload reuses it instead of
// registering a new participant on every load. sessionStorage (not localStorage) scopes it to this
// tab, keeping distinct tabs and devices as distinct presences - a session moves between machines by
// URL (?session=), never by identity. Storage can throw (private mode); fall back to an ephemeral id.
const IDENTITY_KEY = "trevor-web-identity";

function webIdentity(): SessionIdentity {
  try {
    const cached = sessionStorage.getItem(IDENTITY_KEY);
    if (cached) {
      return JSON.parse(cached) as SessionIdentity;
    }
  } catch {
    // storage unavailable: fall through to a fresh, non-persisted identity
  }

  const identity: SessionIdentity = {
    displayName: "trevor-web",
    runtimeKind: RUNTIME_KIND.web,
    instanceId: crypto.randomUUID(),
    participantId: `web-${crypto.randomUUID()}`,
  };

  try {
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // ignore: an ephemeral identity still works for this load
  }

  return identity;
}

/**
 * This browser tab's stable id: the same per-tab instanceId the session identity uses, reused to key
 * tab-local composer state (draft persistence + prompt history, D-083/D-084). sessionStorage already
 * scopes that state to the tab; threading the id into the storage key keeps distinct tabs isolated
 * even under a shared storage (the unit tests rely on that), and keeps the id stable across a reload.
 */
export function webTabId(): string {
  return webIdentity().instanceId;
}

interface ConnectOptions {
  readonly sessionId: string;
  readonly afterSeq?: number;
  readonly onEvent: (event: SessionEvent) => void;
  readonly onReplayComplete?: () => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
  readonly onPresence?: (hosts: readonly HostPresence[]) => void;
}

/** Opens a session stream as this tab's stable web participant (replay-then-tail). */
function connect(sessionTransport: SessionTransport, options: ConnectOptions): SessionConnection {
  return sessionTransport.connectSession({
    sessionId: options.sessionId,
    afterSeq: options.afterSeq,
    identity: webIdentity(),
    onEvent: options.onEvent,
    onReplayComplete: options.onReplayComplete,
    onStatus: options.onStatus,
    onPresence: options.onPresence,
  });
}

/** Publishes one event to the durable log via REST; it returns over the stream. */
function publishEvent(
  sessionTransport: SessionTransport,
  sessionId: string,
  input: PublishInput,
): Promise<void> {
  return sessionTransport.publishEvent(sessionId, input);
}

/**
 * Durably renames ANY session (editable session titles), independent of the current selection - the
 * sidebar renames the row you point at, not just the active session. Publishes a `session.title` to
 * that session's log; the latest wins, and a blank title reverts to the first-prompt-derived one.
 */
export function renameSession(sessionId: string, title: string): Promise<void> {
  return publishEvent(transport, sessionId, {
    producerId: PRODUCER_IDS.web,
    ...sessionEvents.sessionTitle({ title }),
  });
}

/** Archives (or unarchives) ANY session from the sidebar - a durable `session.archived` flag that
 *  hides it from the default sidebar/resume/inventory views (the log is retained). */
export function archiveSession(sessionId: string, archived = true): Promise<void> {
  return publishEvent(transport, sessionId, {
    producerId: PRODUCER_IDS.web,
    ...sessionEvents.sessionArchived({ archived }),
  });
}

/** Soft-deletes (or restores) ANY session from the sidebar - a durable `session.deleted` flag that
 *  hides it from EVERY view. The durable log is retained (a hard purge is a future store operation). */
export function deleteSession(sessionId: string, deleted = true): Promise<void> {
  return publishEvent(transport, sessionId, {
    producerId: PRODUCER_IDS.web,
    ...sessionEvents.sessionDeleted({ deleted }),
  });
}

/** Ensures a session with the given id exists (idempotent) and returns it. */
export function ensureSession(sessionId: string): Promise<string> {
  return transport.ensureSession(sessionId);
}

// --- read side: the live event stream ---

export interface SessionStream {
  readonly events: readonly SessionEvent[];
  /**
   * The hosts connected to the session right now, as the backend's live transport reports it - or null
   * when the backend never reports presence (e.g. Richter), so callers can fall back to the event-log
   * view instead of reading null as "no host".
   */
  readonly presence: readonly HostPresence[] | null;
  readonly replayed: boolean;
  /**
   * Highest seq received during initial replay. Null means the replay boundary is not known yet.
   * Consumers with live-only side effects use this to ignore durable history on page load.
   */
  readonly replayThroughSeq: number | null;
  readonly status: ConnectionStatus;
}

/** Subscribes to a session: replay-then-tail into state. The read side of the session boundary. */
export function useSession(sessionId: string | null): SessionStream {
  return useSessionWithTransport(transport, sessionId);
}

/** Same session hook with an injected transport, exported for deterministic hook tests. */
export function useSessionWithTransport(
  sessionTransport: SessionTransport,
  sessionId: string | null,
): SessionStream {
  const [events, setEvents] = useState<readonly SessionEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [replayed, setReplayed] = useState(false);
  const [replayThroughSeq, setReplayThroughSeq] = useState<number | null>(null);
  const [presence, setPresence] = useState<readonly HostPresence[] | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setStatus("connecting");
      setReplayed(false);
      setReplayThroughSeq(null);
      setPresence(null);
      return;
    }
    setEvents([]);
    setReplayed(false);
    setReplayThroughSeq(null);
    setPresence(null);
    // Buffer the replay burst, commit once. A reload streams the WHOLE history (10k+ events for a
    // long session) as individual onEvent calls. Appending each straight to state would fire one
    // render per event - an O(n^2) storm (every append re-copies the array and recomputes the
    // transcript/panel memos) that janks the catch-up and flashes a half-built transcript. Instead we
    // accumulate replayed events in a local buffer (no setState, no render) and commit them in ONE
    // update when replay completes, so every consumer (transcript, sidebar count, panel) updates a
    // single time. Live tail events (after replay.complete) append individually as before. This is the
    // single place replay is handled, so the gate lives here rather than in each consumer.
    const replayBuffer: SessionEvent[] = [];
    let closed = false;
    let connection: SessionConnection | null = null;
    let lastSeq = 0;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let replaying = true;
    const scheduleReconnect = (): void => {
      if (closed || reconnectTimer !== null) {
        return;
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        start();
      }, delay);
    };
    const onEvent = (event: SessionEvent): void => {
      lastSeq = Math.max(lastSeq, event.seq);
      if (replaying) {
        replayBuffer.push(event);
      } else {
        setEvents((prev) => [...prev, event]);
      }
    };
    const start = (): void => {
      if (closed) {
        return;
      }
      connection = connect(sessionTransport, {
        sessionId,
        afterSeq: lastSeq,
        onEvent,
        onReplayComplete: () => {
          if (!replaying) {
            return;
          }
          replaying = false;
          const replayedEvents = replayBuffer.slice();
          setEvents(replayedEvents);
          setReplayThroughSeq(replayedEvents.at(-1)?.seq ?? 0);
          setReplayed(true);
        },
        onStatus: (next) => {
          setStatus(next);
          if (next === "open") {
            reconnectAttempt = 0;
          } else if (next === "closed") {
            scheduleReconnect();
          }
        },
        onPresence: setPresence,
      });
    };
    start();
    return () => {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      connection?.close();
    };
  }, [sessionId, sessionTransport]);

  return { events, presence, replayed, replayThroughSeq, status };
}

// --- write side: publishing user intents ---

export interface SessionActions {
  readonly publish: (
    text: string,
    provider: string,
    reasoning?: string,
    artifacts?: readonly ArtifactRef[],
    model?: ModelRef,
    pastes?: readonly PastePayload[],
  ) => Promise<void>;
  readonly cancel: (runId: string) => Promise<void>;
  readonly command: (command: string, args: string) => Promise<void>;
  /** The prompt shell lane (D-082): publish a `user.shell` so the leader runs the command now,
   *  bypassing the send queue, the model, and the provider flow. */
  readonly shell: (requestId: string, command: string) => Promise<void>;
  readonly openInEditor: (path: string, line?: number, column?: number) => Promise<void>;
  /** Explicit internet refresh (D-060 M2): ask the host to probe public reachability now. */
  readonly refreshInternet: () => Promise<void>;
  /** Refresh the model catalog (D-065): re-query each source's live /models and re-announce. */
  readonly refreshCatalog: () => Promise<void>;
  /** Start a host-owned source sign-in (D-065 M5): run the OAuth device-code flow for `sourceId`. */
  readonly signInSource: (sourceId: string) => Promise<void>;
  /** Cancel the in-flight source sign-in flow (D-065 M5). */
  readonly cancelSignIn: () => Promise<void>;
  /** Submit the user-pasted code for a browser+paste sign-in (D-065 M5, Anthropic). */
  readonly submitSignInCode: (code: string) => Promise<void>;
  /** Unarchive this session (D-094): clear the durable archived flag so the main UI un-gates. */
  readonly unarchive: () => Promise<void>;
  /** Answer a pending ask_user question: publish the answer so the host resumes the blocked tool call. */
  readonly answerQuestion: (questionId: string, answer: ProviderQuestionAnswer) => Promise<void>;
  /** Recover an orphaned turn (no host connected to ever finish it): publish the same interrupted
   *  terminal event the host's reaper would, so the in-flight latch clears and the session resumes. */
  readonly reconcileTurn: (runId: string) => Promise<void>;
  /** Approve a generated handoff draft (02.10): publish `handoff.approved` so the host runs the
   *  finalized handoff. `prompt` overrides the generated text when the user edited it. */
  readonly approveHandoff: (handoffId: string, prompt?: string) => Promise<void>;
  /** Reject a generated handoff draft: publish `handoff.rejected`; the source session stays active. */
  readonly rejectHandoff: (handoffId: string) => Promise<void>;
}

type PublishVia = (built: TrevorEventInput) => Promise<void>;

export function createSessionActions(publishVia: PublishVia): SessionActions {
  const command = (command: string, args: string) =>
    publishVia(sessionEvents.userCommand({ command, args }));

  return {
    publish: (
      text: string,
      provider: string,
      reasoning?: string,
      artifacts?: readonly ArtifactRef[],
      model?: ModelRef,
      pastes?: readonly PastePayload[],
    ) =>
      publishVia(
        sessionEvents.userMessage({ text, provider, reasoning, model, artifacts, pastes }),
      ),
    cancel: (runId: string) => publishVia(sessionEvents.userCancel({ runId })),
    command,
    shell: (requestId: string, command: string) =>
      publishVia(sessionEvents.userShell({ requestId, command })),
    openInEditor: (path: string, line?: number, column?: number) =>
      publishVia(sessionEvents.editorOpen({ path, line, column })),
    refreshInternet: () => command("/internet-refresh", ""),
    refreshCatalog: () => command("/catalog-refresh", ""),
    signInSource: (sourceId: string) => command("/source-signin", sourceId),
    cancelSignIn: () => command("/source-signin-cancel", ""),
    submitSignInCode: (code: string) => command("/source-signin-code", code),
    unarchive: () => publishVia(sessionEvents.sessionArchived({ archived: false })),
    answerQuestion: (questionId: string, answer: ProviderQuestionAnswer) =>
      publishVia(sessionEvents.providerQuestionAnswer({ questionId, answer })),
    approveHandoff: (handoffId: string, prompt?: string) =>
      publishVia(
        sessionEvents.handoffApproved({ handoffId, ...(prompt != null ? { prompt } : {}) }),
      ),
    rejectHandoff: (handoffId: string) => publishVia(sessionEvents.handoffRejected({ handoffId })),
    // Mirrors the host's `reapExcept` reconcile: an interrupted (not user-cancelled) completion, so the
    // transcript renders it as a host-style reap rather than an ESC, and the in-flight latch releases.
    reconcileTurn: (runId: string) =>
      publishVia(
        sessionEvents.assistantCompleted({
          runId,
          text: "",
          interrupted: true,
          stop: {
            cause: "interrupted",
            action: "failed",
            summary: "No host was connected to finish this turn; the browser recovered it.",
          },
        }),
      ),
  };
}

/**
 * The user intents a session accepts: a prompt, a hard-steer cancel, a slash command, and an
 * editor-open side-channel. The write side of the session boundary, separate from the read stream so a
 * caller that only acts (or only receives) depends on just that half.
 */
export function useSessionActions(sessionId: string | null): SessionActions {
  // Every browser-published event is stamped with the shared web producer id (PRODUCER_IDS.web, owned
  // in @trevor/session) and gated on a live session, so that guard lives here once and the public
  // methods below are one-line delegations to the matching event builder.
  const publishVia = useCallback(
    async (built: TrevorEventInput) => {
      if (!sessionId) {
        return;
      }
      await publishEvent(transport, sessionId, { producerId: PRODUCER_IDS.web, ...built });
    },
    [sessionId],
  );

  return useMemo(() => createSessionActions(publishVia), [publishVia]);
}
