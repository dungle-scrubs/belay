import {
  type ArtifactRef,
  type BlobMetaProbe,
  type DoctorSnapshot,
  type PermanentDeleteResult,
  type PublishInput,
  type ReadLogOptions,
  type SessionConnection,
  type SessionEvent,
  type SessionIdentity,
  type SessionSummary,
  type SessionTransport,
  streamTransport,
  type TrevorEventInput,
  toPublishInput,
} from "@trevor/session";
import { type ArtifactSource, downloadArtifact, headArtifact, uploadArtifact } from "./artifacts";
import {
  type CommandResult,
  doctorSnapshot,
  exportCapabilities,
  type ManifestExport,
  runCommand,
} from "./capabilities";
import { type CatalogSnapshot, listCatalog } from "./catalog";
import { SdkError, type SdkOperation, urlClass, withSdkError } from "./errors";
import { DEFAULT_SDK_PRODUCER_ID, sdkIdentity } from "./identity";
import {
  archiveSession,
  type ListSessionsOptions,
  listSessions,
  unarchiveSession,
} from "./lifecycle";
import {
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
import { projectTranscript, type Transcript } from "./transcript";

/**
 * `@trevor/sdk` - the ergonomic, browser-safe workflow layer ABOVE `@trevor/session` (plan 28). It binds
 * one client to a session backend by URL (the local session-store or a Tether service - identical wire,
 * so the choice is just the URL, D-004), and exposes the useful headless Trevor workflows: read the
 * inventory/transcript, prompt + stream + cancel a turn, switch the model mid-turn, upload/download
 * artifacts, read capabilities/doctor, and run session lifecycle. It talks to backends through the
 * `@trevor/session` protocol only - it never shells out to the CLI (D-002) and never recreates the web
 * UI. Local process orchestration (starting services, spawning hosts, opening the browser, OS signals)
 * stays in `apps/trevor-cli`, not here (D-003).
 */

export interface TrevorClientConfig {
  /** The session backend URL: a local session-store or a Tether service (identical `/sessions` wire). */
  readonly sessionUrl: string;
  /** The content-addressed blob store URL; required only for the artifact workflows. */
  readonly blobUrl?: string;
  /** This client's stream identity (a non-host viewer by default; callers may tag their own). */
  readonly identity?: SessionIdentity;
  /** The producerId stamped on published turns/markers (defaults to the web/viewer producer). */
  readonly producerId?: string;
  /**
   * The bound transport. Defaults to `streamTransport(sessionUrl)` - the one HTTP+WebSocket client both
   * the local store and Tether speak. Injectable so tests can drive an in-memory recording transport.
   */
  readonly transport?: SessionTransport;
}

export class TrevorClient {
  readonly sessionUrl: string;
  readonly blobUrl: string | undefined;
  readonly identity: SessionIdentity;
  readonly producerId: string;
  readonly transport: SessionTransport;

  constructor(config: TrevorClientConfig) {
    this.sessionUrl = config.sessionUrl;
    this.blobUrl = config.blobUrl;
    this.identity = config.identity ?? sdkIdentity();
    this.producerId = config.producerId ?? DEFAULT_SDK_PRODUCER_ID;
    this.transport = config.transport ?? streamTransport(config.sessionUrl);
  }

  /** The blob URL, or a typed error naming the missing configuration (never a bare undefined deref). */
  requireBlobUrl(operation: "uploadArtifact" | "downloadArtifact" | "headArtifact"): string {
    if (!this.blobUrl) {
      throw new SdkError({
        operation,
        backend: "blob",
        backendUrlClass: "<unset>",
        detail: "no blob-store URL configured (pass blobUrl to createTrevorClient)",
      });
    }
    return this.blobUrl;
  }

  /**
   * Runs `run` under this client's SESSION error context: fills in the `backend` + redacted session
   * origin so a workflow (here or a free function taking the client) names only its operation and body
   * instead of re-spelling `{ backend: "session", sessionId, backendUrlClass }` at every call.
   */
  sessionOp<T>(
    operation: SdkOperation,
    sessionId: string | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    return withSdkError(
      {
        operation,
        backend: "session",
        ...(sessionId !== undefined ? { sessionId } : {}),
        backendUrlClass: this.urlClass(),
      },
      run,
    );
  }

  /** Runs `run` under this client's BLOB error context (the blob backend + redacted origin, or `<unset>`). */
  blobOp<T>(operation: SdkOperation, run: () => Promise<T>): Promise<T> {
    return withSdkError(
      {
        operation,
        backend: "blob",
        backendUrlClass: this.blobUrl ? urlClass(this.blobUrl) : "<unset>",
      },
      run,
    );
  }

  /** Ensures a session exists (idempotent); returns its id. Backend failures surface as `SdkError`. */
  ensureSession(sessionId: string): Promise<string> {
    return this.sessionOp("ensureSession", sessionId, () =>
      this.transport.ensureSession(sessionId),
    );
  }

  /** Publishes one already-formed transport event (`{ type, producerId, payload }`) to the durable log,
   *  attributing a backend failure to `operation` (defaults to `publishEvent`). */
  publish(
    sessionId: string,
    input: PublishInput,
    operation: SdkOperation = "publishEvent",
  ): Promise<void> {
    return this.sessionOp(operation, sessionId, () =>
      this.transport.publishEvent(sessionId, input),
    );
  }

  /** Publishes an `events.*` protocol input, stamping this client's producer id. A workflow passes its
   *  own `operation` label so the failure reads as e.g. `prompt`/`cancel`, not a generic `publishEvent`. */
  publishEvent(
    sessionId: string,
    input: TrevorEventInput,
    operation: SdkOperation = "publishEvent",
  ): Promise<void> {
    return this.publish(sessionId, toPublishInput(input, this.producerId), operation);
  }

  /** Reads (replays) the durable log for a session as raw ordered events. */
  readLog(sessionId: string, options?: ReadLogOptions): Promise<readonly SessionEvent[]> {
    return this.sessionOp("readLog", sessionId, () =>
      this.transport.readLog(sessionId, this.identity, options),
    );
  }

  /** The session inventory read model (every durable session's summary). */
  fetchInventory(signal?: AbortSignal): Promise<readonly SessionSummary[]> {
    return this.sessionOp("fetchInventory", undefined, () => this.transport.fetchInventory(signal));
  }

  /**
   * Opens a raw replay-then-tail stream (advanced access): the caller owns the event callback and the
   * returned connection's lifetime, and layers its own reconnect policy. The typed workflows
   * (`streamTurn`, `readModelSwitches`) are built on this; it stays public so a client can read any
   * event - including ones without a typed wrapper yet - directly.
   */
  connect(options: {
    readonly sessionId: string;
    readonly afterSeq?: number;
    readonly onEvent: (event: SessionEvent) => void;
    readonly onReplayComplete?: () => void;
  }): SessionConnection {
    return this.transport.connectSession({
      sessionId: options.sessionId,
      identity: this.identity,
      afterSeq: options.afterSeq,
      onEvent: options.onEvent,
      onReplayComplete: options.onReplayComplete,
    });
  }

  /** Permanently deletes an archived session's storage (typed precondition result, not a throw). */
  permanentlyDeleteSession(sessionId: string): Promise<PermanentDeleteResult> {
    return this.sessionOp("permanentlyDeleteSession", sessionId, () =>
      this.transport.permanentlyDeleteSession(sessionId),
    );
  }

  // --- Transcript / inventory reads (M4) ---

  /** Projects a session's durable log into a lightweight headless transcript (ordered turn entries). */
  async readTranscript(sessionId: string, options?: ReadLogOptions): Promise<Transcript> {
    return projectTranscript(await this.readLog(sessionId, options));
  }

  // --- Prompt / stream / cancel / switch (M5) ---

  /** Submits a user prompt into an existing session (publishes `user.message`); does not wait. */
  prompt(sessionId: string, input: PromptInput): Promise<void> {
    return submitPrompt(this, sessionId, input);
  }

  /** Streams the correlated events of one turn until it completes (or times out); returns a result. */
  streamTurn(sessionId: string, options?: StreamTurnOptions): Promise<TurnResult> {
    return streamTurn(this, sessionId, options);
  }

  /** Cancels the active run (D-094 cancel semantics: publishes `user.cancel`, never an OS signal). */
  cancel(sessionId: string, runId: string): Promise<void> {
    return cancelRun(this, sessionId, runId);
  }

  /** Requests a mid-turn model/reasoning switch on the active run (plan 09.1 `model.switch.requested`). */
  switchModel(sessionId: string, input: SwitchModelInput): Promise<void> {
    return switchModel(this, sessionId, input);
  }

  /** Reads the typed `model.switched` records from a session's durable log. */
  async readModelSwitches(
    sessionId: string,
    options?: ReadLogOptions,
  ): Promise<readonly ModelSwitchRecord[]> {
    return readModelSwitches(await this.readLog(sessionId, options));
  }

  // --- Capabilities / doctor (M4) ---

  /** Runs an immediate host command and returns its structured `command.result` (needs a live host). */
  runCommand(
    sessionId: string,
    command: string,
    args = "",
    options?: { readonly timeoutMs?: number },
  ): Promise<CommandResult> {
    return runCommand(this, sessionId, command, args, options);
  }

  /** Reads the host's capability manifest export (via `/trevor-export`) as typed JSON or human text. */
  exportCapabilities(
    sessionId: string,
    request?: {
      readonly format?: "json" | "text";
      readonly section?: string;
      readonly timeoutMs?: number;
    },
  ): Promise<ManifestExport> {
    return exportCapabilities(this, sessionId, request);
  }

  /** Reads the host's `/doctor` health snapshot (structured), or null when the host sent a text dump. */
  doctor(
    sessionId: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<DoctorSnapshot | null> {
    return doctorSnapshot(this, sessionId, options);
  }

  /** Reads the latest host-announced model sources + per-source catalog from the session log. */
  listCatalog(sessionId: string, options?: ReadLogOptions): Promise<CatalogSnapshot> {
    return listCatalog(this, sessionId, options);
  }

  // --- Artifacts (M3) ---

  /** Uploads bytes to the blob store and returns a structured `ArtifactRef`. */
  uploadArtifact(
    source: ArtifactSource,
    mimeType: string,
    options?: { readonly kind?: ArtifactRef["kind"]; readonly name?: string },
  ): Promise<ArtifactRef> {
    return uploadArtifact(this, source, mimeType, options);
  }

  /** Downloads an artifact's raw bytes by hash or ref. */
  downloadArtifact(ref: string | ArtifactRef): Promise<Uint8Array> {
    return downloadArtifact(this, ref);
  }

  /** Probes an artifact's size + content type by hash (HEAD), or null when absent. */
  headArtifact(hash: string): Promise<BlobMetaProbe | null> {
    return headArtifact(this, hash);
  }

  // --- Lifecycle (M6) ---

  /** Lists sessions from the inventory, scoped to a project and active/archived (pure selection). */
  listSessions(options?: ListSessionsOptions): Promise<readonly SessionSummary[]> {
    return listSessions(this, options);
  }

  /** Archives a session (publishes the durable `session.archived` marker). */
  archive(sessionId: string): Promise<void> {
    return archiveSession(this, sessionId);
  }

  /** Unarchives a session. */
  unarchive(sessionId: string): Promise<void> {
    return unarchiveSession(this, sessionId);
  }

  /** The redacted backend URL class (scheme + host + port) used in structured errors. */
  private urlClass(): string {
    return urlClass(this.sessionUrl);
  }
}

/** Builds a `TrevorClient` bound to a session backend (and optionally a blob store) by URL. */
export function createTrevorClient(config: TrevorClientConfig): TrevorClient {
  return new TrevorClient(config);
}
