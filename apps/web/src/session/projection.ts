import {
  type activeTurnRunId,
  foldLucidReview,
  PRODUCER_IDS,
  type SessionEvent,
} from "@belay/session";
import {
  catalogFrom,
  commandsFrom,
  defaultProviderFrom,
  hostAnnouncement,
  isSessionArchived,
  lastUserModelFrom,
  latestCommandFocusSession,
  latestSessionSwitch,
  modelPrefsFrom,
  pendingHandoffFrom,
  pendingQuestionFrom,
  providerModelsFrom,
  sourceSignInFrom,
  sourcesFrom,
  tasksFrom,
  tasksStale,
  vimEnabledFrom,
  worktreesFrom,
} from "../derive";
import type { QueuedPrompt } from "../send-queue";
import {
  panelModel,
  readOnlyToolBatches,
  TranscriptProjector,
  type toTranscript,
} from "../transcript";

export interface SessionReadModel {
  readonly activeRunId: ReturnType<typeof activeTurnRunId>;
  readonly announcement: ReturnType<typeof hostAnnouncement>;
  readonly archived: boolean;
  readonly awaitingResponse: boolean;
  readonly catalog: ReturnType<typeof catalogFrom>;
  readonly commands: ReturnType<typeof commandsFrom>;
  readonly defaultProvider: ReturnType<typeof defaultProviderFrom>;
  readonly events: readonly SessionEvent[];
  readonly lastUserModel: ReturnType<typeof lastUserModelFrom>;
  readonly lucidReview: ReturnType<typeof foldLucidReview>;
  readonly modelPrefs: ReturnType<typeof modelPrefsFrom>;
  readonly panel: ReturnType<typeof panelModel>;
  readonly pendingHandoff: ReturnType<typeof pendingHandoffFrom>;
  readonly pendingQuestion: ReturnType<typeof pendingQuestionFrom>;
  readonly providerModels: ReturnType<typeof providerModelsFrom>;
  /** The still-queued follow-ups behind the active turn (Tier 0.2): projected once per queue change by
   *  the incremental projector, so the send-queue panel reads it without re-scanning the log per token. */
  readonly queued: readonly QueuedPrompt[];
  readonly signIn: ReturnType<typeof sourceSignInFrom>;
  readonly sources: ReturnType<typeof sourcesFrom>;
  readonly staleTasks: boolean;
  readonly switchAfterReplay: (replayThroughSeq: number | null) => string | null;
  readonly commandFocusAfterReplay: (replayThroughSeq: number | null) => string | null;
  readonly tasks: ReturnType<typeof tasksFrom>;
  readonly toolBatches: ReturnType<typeof readOnlyToolBatches>;
  readonly transcript: ReturnType<typeof toTranscript>;
  readonly transcriptArtifacts: readonly Extract<
    ReturnType<typeof toTranscript>[number],
    { readonly kind: "user" }
  >["artifacts"][number][];
  readonly vimEnabled: boolean;
  readonly worktrees: ReturnType<typeof worktreesFrom>;
}

// Identity-stable empty log for the foreign-events guard below, so consecutive guarded renders
// produce the same (empty) inputs to every fold.
const NO_EVENTS: readonly SessionEvent[] = [];

export function createSessionReadModel(
  events: readonly SessionEvent[],
  options: {
    readonly replayed: boolean;
    /** The session-bound incremental projector (the live app path). When omitted (tests, one-shot
     *  callers) the transcript + queue/active state are folded eagerly, matching the projector by value. */
    readonly projector?: TranscriptProjector;
    /**
     * The session this read model is FOR. When provided, events from any other session are ignored
     * wholesale. This guards the session-switch render: the moment `sessionId` flips (the session
     * query can resolve a revisited id synchronously), the event state still holds the PREVIOUS
     * session's log - useSession only clears it in its effect, AFTER that render. Folding the
     * foreign log would advance the freshly-minted projector's seq cursor past the new session's
     * per-session seqs, so its entire replay would then be skipped and the old transcript would
     * render under the new session id permanently.
     */
    readonly sessionId?: string | null;
  },
): SessionReadModel {
  const log =
    options.sessionId === undefined ||
    events.length === 0 ||
    events[0]?.sessionId === options.sessionId
      ? events
      : NO_EVENTS;
  let transcript: ReturnType<typeof toTranscript>;
  let activeRunId: ReturnType<typeof activeTurnRunId>;
  let awaitingResponse: boolean;
  let queued: readonly QueuedPrompt[];
  if (options.projector) {
    options.projector.applyAll(log);
    const projection = options.projector.project();
    transcript = projection.transcript;
    activeRunId = projection.activeRunId;
    awaitingResponse = projection.awaitingResponse;
    queued = projection.queued;
  } else {
    const projector = new TranscriptProjector({ selfProducerId: PRODUCER_IDS.host });
    projector.applyAll(log);
    const projection = projector.project();
    transcript = projection.transcript;
    activeRunId = projection.activeRunId;
    awaitingResponse = projection.awaitingResponse;
    queued = projection.queued;
  }
  const transcriptArtifacts = transcript.flatMap((message) =>
    message.kind === "user"
      ? message.artifacts
      : message.kind === "lucid"
        ? [message.artifact]
        : [],
  );
  const announcement = hostAnnouncement(log);

  return {
    activeRunId,
    announcement,
    archived: isSessionArchived(log),
    awaitingResponse,
    catalog: catalogFrom(announcement),
    commands: commandsFrom(announcement),
    defaultProvider: defaultProviderFrom(announcement),
    events: log,
    lastUserModel: lastUserModelFrom(log),
    lucidReview: foldLucidReview(log),
    modelPrefs: modelPrefsFrom(announcement),
    panel: panelModel(transcript, log, { replayed: options.replayed }),
    pendingHandoff: pendingHandoffFrom(log),
    pendingQuestion: pendingQuestionFrom(log),
    providerModels: providerModelsFrom(announcement),
    queued,
    signIn: sourceSignInFrom(log),
    sources: sourcesFrom(announcement),
    staleTasks: tasksStale(log),
    switchAfterReplay: (replayThroughSeq) =>
      replayThroughSeq === null ? null : latestSessionSwitch(log, { afterSeq: replayThroughSeq }),
    commandFocusAfterReplay: (replayThroughSeq) =>
      replayThroughSeq === null
        ? null
        : latestCommandFocusSession(log, { afterSeq: replayThroughSeq }),
    tasks: tasksFrom(log),
    toolBatches: readOnlyToolBatches(transcript),
    transcript,
    transcriptArtifacts,
    vimEnabled: vimEnabledFrom(announcement),
    worktrees: worktreesFrom(announcement),
  };
}
