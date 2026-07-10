import {
  type ConnectionStatus,
  freshSessionId,
  type HostPresence,
  type LucidFeedbackBatch,
  type ModelRef,
  type PermanentDeleteResult,
  PRODUCER_IDS,
  type ProviderQuestionAnswer,
  type PublishInput,
  planTangent,
  type SessionConnection,
  type SessionEvent,
  type SessionIdentity,
  type SessionTransport,
  type SupersedeReason,
  events as sessionEvents,
  streamTransport,
  type TangentAnchorSeed,
  type TangentFoldMode,
  type TrevorEventInput,
  toPublishInput,
  viewerIdentity,
} from "@trevor/session";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { UserTurnInput } from "@/send-queue";

export type { ConnectionStatus, HostPresence };

/**
 * The web session boundary: the transport binding (backend selection + this tab's identity) plus the
 * two React hooks the app subscribes through. Receiving and acting are split (D-018):
 *   - `useSession` accumulates the replay-then-tail event stream into state (read side),
 *   - `useSessionActions` publishes user intents - prompt / cancel / command / editor-open (write side).
 * Backend selection is a single `streamTransport(url)` call - Tether speaks the same `/sessions`
 * REST + WS contract as the local store, so it is just that URL, not a separate adapter. The stream
 * URL, decode loop, and REST calls live in `@trevor/session`, so host and browser can never drift on
 * the protocol.
 */

// Backend selection: by default the browser talks same-origin to the local session-store, which the
// Vite dev proxy forwards /sessions (REST + WS) to (no CORS). Set VITE_TETHER_URL to point the same
// transport at a Tether durable substrate instead (a Tether that serves CORS directly).
const TETHER_URL = import.meta.env.VITE_TETHER_URL;
const transport = TETHER_URL
  ? streamTransport(TETHER_URL)
  : streamTransport(window.location.origin);

/** This tab's shared transport singleton, exported so a self-contained surface (e.g. the tangent
 *  takeover) can bind a SECOND session's stream/actions to the same backend, and tests can substitute a
 *  recording transport. Prefer the hooks below; reach for this only when wiring another session id. */
export const sessionTransport: SessionTransport = transport;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 2_000;
// Live tail deltas coalesce into one state commit per ~frame (see the tail buffer in
// `useSessionWithTransport`). 16ms tracks a 60fps frame; a plain setTimeout (not rAF) keeps the
// flush deterministic under fake timers in jsdom tests and still fires in background tabs.
// Exported so hook tests that deliver live tail events advance fake timers by exactly this window.
export const TAIL_FLUSH_MS = 16;

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

  const identity = viewerIdentity({
    displayName: "trevor-web",
    instanceId: crypto.randomUUID(),
    participantId: `web-${crypto.randomUUID()}`,
  });

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

/** Publishes one already-stamped event to the durable log via REST; it returns over the stream. */
function publishEvent(
  sessionTransport: SessionTransport,
  sessionId: string,
  input: PublishInput,
): Promise<void> {
  return sessionTransport.publishEvent(sessionId, input);
}

/**
 * Publishes a BROWSER event: stamps the shared web producer id (`PRODUCER_IDS.web`, owned in
 * `@trevor/session`) onto the envelope and publishes it. The one owner of "web events are producer
 * `web`", so no browser publish path - the session free functions here, `publishVia`, or the
 * new-session hooks - re-spreads the stamp or can forget it.
 */
export function publishWebEvent(
  sessionTransport: SessionTransport,
  sessionId: string,
  built: TrevorEventInput,
): Promise<void> {
  return sessionTransport.publishEvent(sessionId, toPublishInput(built, PRODUCER_IDS.web));
}

/**
 * Durably renames ANY session (editable session titles), independent of the current selection - the
 * sidebar renames the row you point at, not just the active session. Publishes a `session.title` to
 * that session's log; the latest wins, and a blank title reverts to the first-prompt-derived one.
 */
export function renameSession(sessionId: string, title: string): Promise<void> {
  return publishWebEvent(transport, sessionId, sessionEvents.sessionTitle({ title }));
}

/** Archives (or unarchives) ANY session from the sidebar - a durable `session.archived` flag that
 *  hides it from the default sidebar/resume/inventory views (the log is retained). */
export function archiveSession(sessionId: string, archived = true): Promise<void> {
  return publishWebEvent(transport, sessionId, sessionEvents.sessionArchived({ archived }));
}

/** Soft-deletes (or restores) ANY session from the sidebar - a durable `session.deleted` flag that
 *  hides it from EVERY view. The durable log is RETAINED; this only hides. The destructive purge is
 *  the separate {@link permanentlyDeleteSession} (plan 04), reachable only from the archive browser. */
export function deleteSession(sessionId: string, deleted = true): Promise<void> {
  return publishWebEvent(transport, sessionId, sessionEvents.sessionDeleted({ deleted }));
}

/** Permanently purges an archived session's durable storage (plan 04) - the hard delete distinct from
 *  the soft-delete `session.deleted` marker above. The store is the authoritative gate, so a
 *  precondition rejection (not archived, a live host, an active turn) comes back as a typed
 *  `{ ok: false }` result rather than throwing; it throws only on a transport failure. */
export function permanentlyDeleteSession(sessionId: string): Promise<PermanentDeleteResult> {
  return transport.permanentlyDeleteSession(sessionId);
}

/** Ensures a session with the given id exists (idempotent) and returns it. */
export function ensureSession(sessionId: string): Promise<string> {
  return transport.ensureSession(sessionId);
}

/**
 * Creates a fresh, ISOLATED tangent session (plan 37, M5) branched from a selected snapshot: mints a
 * tangent id, ensures it in the store, and publishes ONLY the `session.tangentOf` lineage marker (via
 * {@link planTangent} - no parent transcript is copied). Returns the new tangent session id the takeover
 * subscribes to. The seed snapshot rides the tangent's FIRST prompt (see `seedTangentPrompt`), not a
 * standalone message, so isolation is structural.
 */
export function createTangentSession(anchor: TangentAnchorSeed): Promise<string> {
  return createTangentSessionWith(transport, anchor);
}

/** {@link createTangentSession} with an injected transport, for deterministic hook tests. */
export async function createTangentSessionWith(
  sessionTransport: SessionTransport,
  anchor: TangentAnchorSeed,
): Promise<string> {
  const tangentSessionId = freshSessionId({ prefix: "tangent" });
  const plan = planTangent({ anchor, tangentSessionId });
  await sessionTransport.ensureSession(tangentSessionId);
  for (const input of plan.events) {
    await publishEvent(sessionTransport, tangentSessionId, input);
  }
  await publishTangentCreatedWakeUp(sessionTransport, {
    parentSessionId: plan.parentSessionId,
    sourceMessageId: plan.sourceMessageId,
    tangentSessionId: plan.tangentSessionId,
  });
  return tangentSessionId;
}

async function publishTangentCreatedWakeUp(
  sessionTransport: SessionTransport,
  args: {
    readonly parentSessionId: string;
    readonly sourceMessageId: string;
    readonly tangentSessionId: string;
  },
): Promise<void> {
  try {
    await publishWebEvent(
      sessionTransport,
      args.parentSessionId,
      sessionEvents.tangentCreated({
        sourceMessageId: args.sourceMessageId,
        tangentSessionId: args.tangentSessionId,
      }),
    );
  } catch {
    // Best-effort fast path: the tangent marker is durable, and the host inventory poll repairs misses.
  }
}

/**
 * Records an EXPLICIT tangent fold-back (plan 37, M8) on the TANGENT session's log - the durable,
 * auditable marker that the user carried a chosen piece of the tangent back toward the parent for review.
 * It is written to the TANGENT (never the parent), so it can never enter the parent's model context; the
 * folded text lands in the parent COMPOSER separately, as editable text the user reviews before sending.
 */
export function recordTangentFoldBack(
  tangentSessionId: string,
  p: { parentSessionId: string; mode: TangentFoldMode; preview: string },
): Promise<void> {
  return publishWebEvent(
    transport,
    tangentSessionId,
    sessionEvents.tangentFoldedBack({ tangentSessionId, ...p }),
  );
}

// --- read side: the live event stream ---

export interface SessionStream {
  readonly events: readonly SessionEvent[];
  /**
   * The hosts connected to the session right now, as the backend's live transport reports it - or null
   * when the backend never reports presence (e.g. Tether), so callers can fall back to the event-log
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
    // Buffer replay bursts, commit each once. A reload streams the WHOLE history (10k+ events for a
    // long session) as individual onEvent calls. Appending each straight to state would fire one
    // render per event - an O(n^2) storm (every append re-copies the array and recomputes the
    // transcript/panel memos) that janks the catch-up and flashes a half-built transcript. Instead
    // each connection attempt accumulates its replayed events in a local buffer (no setState, no
    // render) and commits them in ONE update when that connection's replay completes, so every
    // consumer (transcript, sidebar count, panel) updates a single time. The commit is asymmetric:
    // the FIRST replay is the full history and REPLACES state (it also stamps the page-load boundary
    // - replayed/replayThroughSeq - exactly once); a RECONNECT catch-up connects with
    // afterSeq=lastSeq, so the server sends only missed events and the batch APPENDS to existing
    // state without touching the boundary consumers key live-only side effects on. This is the
    // single place replay is handled, so the gate lives here rather than in each consumer. The
    // replay buffer lives at EFFECT scope (shared by every connection attempt), not per
    // connection: `onEvent` advances `lastSeq` for each buffered replay event and a reconnect
    // asks for `afterSeq = lastSeq`, so the server never resends what was buffered - a
    // per-connection buffer discarded on a mid-replay disconnect would lose that range for good
    // (and the next attempt would commit a truncated log as the full history). The surviving
    // buffer lets the next attempt keep appending and commit the union at ITS replay.complete.
    let closed = false;
    let connection: SessionConnection | null = null;
    let lastSeq = 0;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let initialReplayDone = false;
    // Live tail batching: a streaming turn delivers deltas far faster than 60fps, and committing
    // each one re-renders the whole subscriber tree per delta. Tail events accumulate here and
    // flush as ONE append per TAIL_FLUSH_MS window (trailing edge), so render cost tracks frames,
    // not event rate. Order is preserved (single buffer, splice-then-append), and every teardown
    // path - connection close, session switch, unmount - flushes rather than drops the buffer.
    const tailBuffer: SessionEvent[] = [];
    // Replay events buffered but not yet committed (see the effect-scope rationale above). A
    // connection that dies mid-replay leaves its events here for the next attempt to extend.
    const replayBuffer: SessionEvent[] = [];
    let tailFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushTail = (): void => {
      if (tailFlushTimer !== null) {
        clearTimeout(tailFlushTimer);
        tailFlushTimer = null;
      }
      if (tailBuffer.length === 0) {
        return;
      }
      const batch = tailBuffer.splice(0);
      setEvents((prev) => [...prev, ...batch]);
    };
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
    const start = (): void => {
      if (closed) {
        return;
      }
      // Per-connection replay mode: EVERY attempt (first connect and each reconnect) opens in
      // replay - the stream contract is replay-then-tail on every connection - so a mid-stream
      // network flap buffers its catch-up burst instead of dripping it through the tail path.
      let replaying = true;
      connection = connect(sessionTransport, {
        sessionId,
        afterSeq: lastSeq,
        onEvent: (event) => {
          lastSeq = Math.max(lastSeq, event.seq);
          if (replaying) {
            replayBuffer.push(event);
            return;
          }
          tailBuffer.push(event);
          if (tailFlushTimer === null) {
            tailFlushTimer = setTimeout(flushTail, TAIL_FLUSH_MS);
          }
        },
        onReplayComplete: () => {
          if (!replaying) {
            return;
          }
          replaying = false;
          const batch = replayBuffer.splice(0);
          if (initialReplayDone) {
            // Reconnect catch-up: flush tail stragglers first so seq order is kept, then append
            // the missed events in one commit. replayed/replayThroughSeq stay untouched - they
            // mark the initial page-load boundary, not this connection's replay.
            flushTail();
            if (batch.length > 0) {
              setEvents((prev) => [...prev, ...batch]);
            }
            return;
          }
          initialReplayDone = true;
          setEvents(batch);
          setReplayThroughSeq(batch.at(-1)?.seq ?? 0);
          setReplayed(true);
        },
        onStatus: (next) => {
          setStatus(next);
          if (next === "open") {
            reconnectAttempt = 0;
          } else if (next === "closed") {
            // Commit whatever the dying connection already delivered before backing off, so the
            // UI is current during the reconnect gap and the batch can never interleave with the
            // next connection's catch-up append.
            flushTail();
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
      // Flush, don't drop: on a session switch the next effect run resets state anyway, and after
      // unmount the setState is a no-op - but a still-mounted consumer never loses a buffered event.
      flushTail();
      connection?.close();
    };
  }, [sessionId, sessionTransport]);

  // One stable stream object per state change (Tier 1): PanelHost's memo compares its `stream`
  // prop by identity, so a fresh literal here would re-render the whole layout on EVERY App
  // render (clock ticks, keystrokes) instead of only when the stream actually advanced.
  return useMemo(
    () => ({ events, presence, replayed, replayThroughSeq, status }),
    [events, presence, replayed, replayThroughSeq, status],
  );
}

// --- write side: publishing user intents ---

export interface SessionActions {
  readonly publish: (prompt: UserTurnInput) => Promise<void>;
  /**
   * Retract queued follow-ups from the durable queue (plan 47 D-003): publish a `user.supersede`
   * naming their durable eventIds so the host drops them from catch-up + the prompt projection. Powers
   * the Escape-fold (`reason: "fold"`, published alongside the one folded replacement `user.message`),
   * unqueue (`"unqueue"`), and recall-pull (`"recall"`) - all on the append-only log, never a mutation.
   */
  readonly supersede: (supersedes: readonly string[], reason: SupersedeReason) => Promise<void>;
  readonly cancel: (runId: string, steered?: boolean) => Promise<void>;
  /** Switch the in-flight turn's model/reasoning mid-flight (plan 09.1): publish a
   *  `model.switch.requested` keyed to the active runId, which the host routes to that turn's switch
   *  cell. A no-op on the host when `runId` is not the active turn. */
  readonly switchModel: (runId: string, model: ModelRef) => Promise<void>;
  readonly command: (command: string, args: string) => Promise<void>;
  /** The prompt shell lane (D-082): publish a `user.shell` so the leader runs the command now,
   *  bypassing the send queue, the model, and the provider flow. */
  readonly shell: (requestId: string, command: string) => Promise<void>;
  /** The `@`-file-mention picker (plan 30): ask the live leader for the workspace file index once,
   *  paired by `requestId`; the browser then fuzzy-filters the cached index locally per keystroke. */
  readonly requestFileIndex: (requestId: string) => Promise<void>;
  readonly openInEditor: (path: string, line?: number, column?: number) => Promise<void>;
  /** Explicit internet refresh (D-060 M2): ask the host to probe public reachability now. */
  readonly refreshInternet: () => Promise<void>;
  /** Refresh the model catalog (D-065): re-query each source's live /models and re-announce. */
  readonly refreshCatalog: () => Promise<void>;
  /** Set the durable DEFAULT model host-side (plan 51): the host persists it + re-announces. */
  readonly setModelDefault: (ref: ModelRef) => Promise<void>;
  /** Toggle a FAVORITE model host-side (plan 51): the host adds/removes it + re-announces. */
  readonly toggleModelFavorite: (ref: ModelRef) => Promise<void>;
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
  /** Recover an orphaned background subagent (plan 52): publish a terminal `delegated.to{interrupted}`
   *  keyed by `childSessionId` - the browser mirror of the host's `reapOrphanSubagents`. Carries the
   *  original link fields so the transcript reducer advances the EXISTING delegation block in place. */
  readonly reconcileSubagent: (link: {
    readonly runId: string;
    readonly childSessionId: string;
    readonly agent: string;
    readonly task: string;
    readonly mode: "inline" | "background";
  }) => Promise<void>;
  /** Approve a generated handoff draft (02.10): publish `handoff.approved` so the host runs the
   *  finalized handoff. `prompt` overrides the generated text when the user edited it. */
  readonly approveHandoff: (handoffId: string, prompt?: string) => Promise<void>;
  /** Reject a generated handoff draft: publish `handoff.rejected`; the source session stays active. */
  readonly rejectHandoff: (handoffId: string) => Promise<void>;
  /** Deliver located Lucid review feedback (plan 27, M5): publish `lucid.feedback` so the located
   *  annotations reach the agent as STRUCTURED DATA (the host frames them safely, never as raw prompt). */
  readonly deliverLucidFeedback: (batch: LucidFeedbackBatch) => Promise<void>;
  /** Change a Lucid artifact's review status (plan 27, M6): publish `lucid.review` (resolved/reopened). */
  readonly setLucidReview: (lucidId: string, resolved: boolean, cursor: number) => Promise<void>;
}

type PublishVia = (built: TrevorEventInput) => Promise<void>;

export function createSessionActions(publishVia: PublishVia): SessionActions {
  const command = (command: string, args: string) =>
    publishVia(sessionEvents.userCommand({ command, args }));

  return {
    publish: (prompt) => publishVia(sessionEvents.userMessage(prompt)),
    supersede: (supersedes: readonly string[], reason: SupersedeReason) =>
      publishVia(sessionEvents.userSupersede({ supersedes, reason })),
    cancel: (runId: string, steered?: boolean) =>
      publishVia(sessionEvents.userCancel({ runId, ...(steered ? { steered: true } : {}) })),
    switchModel: (runId: string, model: ModelRef) =>
      publishVia(sessionEvents.modelSwitchRequested({ runId, model, initiator: "manual" })),
    command,
    shell: (requestId: string, command: string) =>
      publishVia(sessionEvents.userShell({ requestId, command })),
    requestFileIndex: (requestId: string) =>
      publishVia(sessionEvents.fileIndexRequested({ requestId })),
    openInEditor: (path: string, line?: number, column?: number) =>
      publishVia(sessionEvents.editorOpen({ path, line, column })),
    refreshInternet: () => command("/internet-refresh", ""),
    refreshCatalog: () => command("/catalog-refresh", ""),
    // The default/favorite mutations (plan 51) round-trip through the host: the ref rides as a JSON arg
    // (a model id can contain "/", so a single-token encoding won't do); the host persists + re-announces.
    setModelDefault: (ref: ModelRef) => command("/model-default", JSON.stringify(ref)),
    toggleModelFavorite: (ref: ModelRef) => command("/model-favorite", JSON.stringify(ref)),
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
    deliverLucidFeedback: (batch: LucidFeedbackBatch) =>
      publishVia(
        sessionEvents.lucidFeedback({
          lucidId: batch.lucidId,
          version: batch.version,
          cursor: batch.cursor,
          annotations: batch.annotations,
          ...(batch.message ? { message: batch.message } : {}),
        }),
      ),
    setLucidReview: (lucidId: string, resolved: boolean, cursor: number) =>
      publishVia(sessionEvents.lucidReview({ lucidId, resolved, cursor })),
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
    // Mirrors the host's `reapOrphanSubagents`: a terminal `interrupted` link (not `failed` - the child
    // was recovered, not a genuine task error) keyed by `childSessionId`, carrying the original link
    // fields so the reducer advances the existing block. Idempotent by key with the host reap.
    reconcileSubagent: (link) =>
      publishVia(
        sessionEvents.delegatedTo({
          ...link,
          status: "interrupted",
          result: "No host was connected to finish this subagent; the browser recovered it.",
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
  return useSessionActionsWithTransport(transport, sessionId);
}

/** Same write-side hook with an injected transport, so a self-contained surface (the tangent takeover)
 *  can publish into a SECOND session, and hook tests can drive a recording transport. */
export function useSessionActionsWithTransport(
  sessionTransportArg: SessionTransport,
  sessionId: string | null,
): SessionActions {
  // Every browser-published event is stamped with the shared web producer id (PRODUCER_IDS.web, owned
  // in @trevor/session) and gated on a live session, so that guard lives here once and the public
  // methods below are one-line delegations to the matching event builder.
  const publishVia = useCallback(
    async (built: TrevorEventInput) => {
      if (!sessionId) {
        return;
      }
      await publishWebEvent(sessionTransportArg, sessionId, built);
    },
    [sessionTransportArg, sessionId],
  );

  return useMemo(() => createSessionActions(publishVia), [publishVia]);
}
