import {
  type ArtifactRef,
  decodeTrevorEvent,
  events,
  type ModelRef,
  type ModelSwitchEndpoint,
  type ModelSwitchInitiator,
  type ModelSwitchOutcome,
  type SessionEvent,
  toPublishInput,
} from "@trevor/session";
import { awaitStreamResult } from "./await-stream";
import type { TrevorClient } from "./client";
import { SdkError, urlClass, withSdkError } from "./errors";

/**
 * The SDK prompt/stream/cancel/switch workflows (plan 28 M5). They are deliberately SESSION-ORIENTED,
 * not a hidden one-shot `ask()`: a caller submits a prompt into an existing session and separately
 * streams the correlated turn events, so streaming, cancellation, and mid-turn switching compose the
 * same way the web and host use the session event contract. `cancel` publishes the D-094 `user.cancel`
 * control event (never an OS signal - stop/kill live in the CLI/local layer). `switchModel` emits the
 * plan 09.1 `model.switch.requested` control event into the active run, parallel to cancel, and
 * `readModelSwitches` projects the durable `model.switched` records with raw event access as the
 * fallback for anything not yet typed.
 */

/** A prompt to submit into a session: the text plus the provider/model selection it runs under. */
export interface PromptInput {
  readonly text: string;
  /** The legacy provider source id (carried alongside `model` for old consumers). */
  readonly provider: string;
  readonly reasoning?: string;
  readonly model?: ModelRef;
  readonly artifacts?: readonly ArtifactRef[];
}

/** Submits a user prompt into an existing session (publishes `user.message`). Does not wait for a turn. */
export function submitPrompt(
  client: TrevorClient,
  sessionId: string,
  input: PromptInput,
): Promise<void> {
  return withSdkError(
    {
      operation: "prompt",
      backend: "session",
      sessionId,
      backendUrlClass: urlClass(client.sessionUrl),
    },
    () =>
      client.transport.publishEvent(
        sessionId,
        toPublishInput(events.userMessage(input), client.producerId),
      ),
  );
}

/** Cancels the active run (D-094 cancel): publishes `user.cancel` for `runId`, never an OS signal. */
export function cancelRun(client: TrevorClient, sessionId: string, runId: string): Promise<void> {
  return withSdkError(
    {
      operation: "cancel",
      backend: "session",
      sessionId,
      backendUrlClass: urlClass(client.sessionUrl),
    },
    () =>
      client.transport.publishEvent(
        sessionId,
        toPublishInput(events.userCancel({ runId }), client.producerId),
      ),
  );
}

/** A mid-turn switch request: the target model ref and who asked (defaults to a programmatic switch). */
export interface SwitchModelInput {
  readonly runId: string;
  readonly model: ModelRef;
  readonly initiator?: ModelSwitchInitiator;
}

/**
 * Requests a mid-turn model/reasoning switch on the active run (plan 09.1): publishes the
 * `model.switch.requested` control event into the turn's switch cell. Parallel to `cancelRun` - a control
 * event routed to the in-flight `runId`; a request with no matching active turn is a host no-op. The
 * default initiator is `auto` (a programmatic switch), distinct from a human `manual` selection.
 */
export function switchModel(
  client: TrevorClient,
  sessionId: string,
  input: SwitchModelInput,
): Promise<void> {
  return withSdkError(
    {
      operation: "switchModel",
      backend: "session",
      sessionId,
      backendUrlClass: urlClass(client.sessionUrl),
    },
    () =>
      client.transport.publishEvent(
        sessionId,
        toPublishInput(
          events.modelSwitchRequested({
            runId: input.runId,
            model: input.model,
            initiator: input.initiator ?? "auto",
          }),
          client.producerId,
        ),
      ),
  );
}

/** A typed `model.switched` record projected from the durable log (M5 typed read). */
export interface ModelSwitchRecord {
  readonly runId: string;
  readonly from: ModelSwitchEndpoint;
  readonly to: ModelSwitchEndpoint;
  readonly initiator: ModelSwitchInitiator;
  readonly outcome: ModelSwitchOutcome;
  readonly reason?: string;
  readonly seq: number;
}

/** Projects the durable `model.switched` events from a log into typed switch records, in seq order. */
export function readModelSwitches(log: readonly SessionEvent[]): readonly ModelSwitchRecord[] {
  const records: ModelSwitchRecord[] = [];
  for (const event of log) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "model.switched") {
      records.push({
        runId: decoded.runId,
        from: decoded.from,
        to: decoded.to,
        initiator: decoded.initiator,
        outcome: decoded.outcome,
        ...(decoded.reason !== undefined ? { reason: decoded.reason } : {}),
        seq: event.seq,
      });
    }
  }
  return records;
}

export interface StreamTurnOptions {
  /** Replay from after this seq (default 0 = from the start). Pass the seq before a prompt to scope it. */
  readonly afterSeq?: number;
  /** Correlate to a specific run; when omitted, the first `assistant.started` seen defines the run. */
  readonly runId?: string;
  /** Called for every event on the stream (raw access), before terminal detection. */
  readonly onEvent?: (event: SessionEvent) => void;
  /** How long to wait for the turn to complete before resolving `timedOut` (default 60s). */
  readonly timeoutMs?: number;
}

/** The result of streaming one turn to its terminal `assistant.completed` (or a timeout). */
export interface TurnResult {
  /** The correlated run id, or null when no `assistant.started`/`assistant.completed` was seen. */
  readonly runId: string | null;
  /** Every event seen on the stream for the correlated run, in order. */
  readonly events: readonly SessionEvent[];
  /** The assistant's final answer text, or "" when the turn did not complete. */
  readonly text: string;
  /** Whether the terminal completion was a cancellation. */
  readonly cancelled: boolean;
  /** True when the timeout elapsed before a terminal completion was seen. */
  readonly timedOut: boolean;
}

const DEFAULT_TURN_TIMEOUT_MS = 60_000;

/**
 * Streams the correlated events of one turn until its terminal `assistant.completed` (or the timeout).
 * The turn is identified by the first `assistant.started` seen after `afterSeq` (or the explicit
 * `runId`), and events carrying that run id - plus the started/completed pair - are collected. The
 * stream is always closed before this resolves. It never publishes; a caller submits the prompt
 * separately (so streaming and prompting compose without a hidden one-shot API).
 */
export function streamTurn(
  client: TrevorClient,
  sessionId: string,
  options: StreamTurnOptions = {},
): Promise<TurnResult> {
  return withSdkError(
    {
      operation: "streamTurn",
      backend: "session",
      sessionId,
      backendUrlClass: urlClass(client.sessionUrl),
    },
    () => {
      const collected: SessionEvent[] = [];
      let runId: string | null = options.runId ?? null;
      const belongs = (decodedRunId: string | undefined): boolean =>
        runId === null || decodedRunId === runId;
      return awaitStreamResult<TurnResult>(
        client,
        { sessionId, afterSeq: options.afterSeq ?? 0 },
        options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        ({ settle, resolve, reject }) => ({
          onEvent: (event) => {
            options.onEvent?.(event);
            const decoded = decodeTrevorEvent(event);
            if (!decoded) {
              return;
            }
            if (decoded.type === "assistant.started" && runId === null) {
              runId = decoded.runId;
            }
            const eventRunId =
              "runId" in decoded && typeof decoded.runId === "string" ? decoded.runId : undefined;
            if (eventRunId !== undefined && belongs(eventRunId)) {
              collected.push(event);
            }
            if (decoded.type === "assistant.completed" && belongs(decoded.runId)) {
              settle(() =>
                resolve({
                  runId: decoded.runId,
                  text: decoded.text,
                  cancelled: decoded.cancelled,
                  timedOut: false,
                  events: collected,
                }),
              );
            }
          },
          onStatus: (status) => {
            if (status === "closed") {
              settle(() =>
                reject(
                  new SdkError({
                    operation: "streamTurn",
                    backend: "session",
                    sessionId,
                    backendUrlClass: urlClass(client.sessionUrl),
                    detail: "stream closed before the turn completed",
                  }),
                ),
              );
            }
          },
        }),
        ({ settle, resolve }) =>
          settle(() =>
            resolve({ runId, text: "", cancelled: false, timedOut: true, events: collected }),
          ),
      );
    },
  );
}
