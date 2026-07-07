import { activeTurnRunId, foldLucidReview, PRODUCER_IDS, type SessionEvent } from "@trevor/session";
import {
  catalogFrom,
  commandsFrom,
  defaultProviderFrom,
  hostAnnouncement,
  isSessionArchived,
  lastUserModelFrom,
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
import { panelModel, readOnlyToolBatches, toTranscript } from "../transcript";

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
  readonly signIn: ReturnType<typeof sourceSignInFrom>;
  readonly sources: ReturnType<typeof sourcesFrom>;
  readonly staleTasks: boolean;
  readonly switchAfterReplay: (replayThroughSeq: number | null) => string | null;
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

export function createSessionReadModel(
  events: readonly SessionEvent[],
  options: { readonly replayed: boolean },
): SessionReadModel {
  const transcript = toTranscript(events, { selfProducerId: PRODUCER_IDS.host });
  const transcriptArtifacts = transcript.flatMap((message) =>
    message.kind === "user"
      ? message.artifacts
      : message.kind === "lucid"
        ? [message.artifact]
        : [],
  );
  const announcement = hostAnnouncement(events);

  return {
    activeRunId: activeTurnRunId(events),
    announcement,
    archived: isSessionArchived(events),
    awaitingResponse: transcript.at(-1)?.kind === "user",
    catalog: catalogFrom(announcement),
    commands: commandsFrom(announcement),
    defaultProvider: defaultProviderFrom(announcement),
    events,
    lastUserModel: lastUserModelFrom(events),
    lucidReview: foldLucidReview(events),
    modelPrefs: modelPrefsFrom(announcement),
    panel: panelModel(transcript, events, { replayed: options.replayed }),
    pendingHandoff: pendingHandoffFrom(events),
    pendingQuestion: pendingQuestionFrom(events),
    providerModels: providerModelsFrom(announcement),
    signIn: sourceSignInFrom(events),
    sources: sourcesFrom(announcement),
    staleTasks: tasksStale(events),
    switchAfterReplay: (replayThroughSeq) =>
      replayThroughSeq === null
        ? null
        : latestSessionSwitch(events, { afterSeq: replayThroughSeq }),
    tasks: tasksFrom(events),
    toolBatches: readOnlyToolBatches(transcript),
    transcript,
    transcriptArtifacts,
    vimEnabled: vimEnabledFrom(announcement),
    worktrees: worktreesFrom(announcement),
  };
}
