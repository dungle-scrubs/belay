/**
 * `@trevor/sdk` - the ergonomic, browser-safe headless workflow layer above `@trevor/session` (plan 28).
 *
 * Build a client with {@link createTrevorClient}, bound to a session backend (and optionally a blob
 * store) by URL, then use the workflows: read the inventory/transcript, prompt/stream/cancel a turn,
 * switch the model mid-turn, upload/download artifacts, read capabilities/doctor, and run session
 * lifecycle. It speaks the `@trevor/session` protocol only - it never runs the CLI and never recreates
 * the web UI. Local process orchestration (services, host spawn, browser, OS signals) stays in the CLI.
 */

export {
  type ArtifactSource,
  downloadArtifact,
  headArtifact,
  uploadArtifact,
} from "./artifacts";
export {
  type CommandResult,
  doctorSnapshot,
  exportCapabilities,
  type ManifestExport,
  runCommand,
} from "./capabilities";
export {
  type CatalogSnapshot,
  EMPTY_CATALOG_SNAPSHOT,
  listCatalog,
  projectCatalog,
} from "./catalog";
export {
  createTrevorClient,
  TrevorClient,
  type TrevorClientConfig,
} from "./client";
export {
  isSdkError,
  type SdkBackend,
  SdkError,
  type SdkErrorContext,
  type SdkOperation,
  urlClass,
  withSdkError,
} from "./errors";
export {
  DEFAULT_SDK_PRODUCER_ID,
  SDK_DISPLAY_NAME,
  sdkIdentity,
} from "./identity";
export {
  archiveSession,
  expandHome,
  type ListSessionsOptions,
  listSessions,
  type OpenTarget,
  resolveOpenTarget,
  selectSessions,
  unarchiveSession,
} from "./lifecycle";
export {
  cancelRun,
  type ModelSwitchRecord,
  type PromptInput,
  readModelSwitches,
  type StreamTurnOptions,
  type SwitchModelInput,
  streamTurn,
  submitPrompt,
  switchModel,
  type TurnResult,
} from "./prompt";
export {
  projectTranscript,
  type Transcript,
  type TranscriptEntry,
  type TranscriptRole,
} from "./transcript";
