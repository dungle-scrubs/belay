import { Schema } from "effect";
import { SessionEvent } from "./event";

/**
 * The session stream envelope (op-tagged): how a session backend frames messages
 * on the replay-then-tail WebSocket. This is the shared wire every backend speaks
 * - the local session-store and the Richter service both emit these frames, so a
 * single client (./stream-transport) decodes either. Unknown ops fail decode and
 * are ignored by clients, preserving forward-compatibility as backends add frames.
 */
export const StreamEnvelope = Schema.Union(
  Schema.Struct({ op: Schema.Literal("event"), event: SessionEvent }),
  Schema.Struct({ op: Schema.Literal("replay.complete") }),
  Schema.Struct({
    op: Schema.Literal("command.result"),
    command: Schema.String,
    requestId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("error"),
    error: Schema.String,
    requestId: Schema.optional(Schema.String),
  }),
);
export type StreamEnvelope = Schema.Schema.Type<typeof StreamEnvelope>;

/** Decodes one raw stream envelope, returning Either for boundary handling. */
export const decodeStreamEnvelope = Schema.decodeUnknownEither(StreamEnvelope);

// --- emit side: typed frame constructors (single source of the `op` vocabulary) ---

/**
 * Constructors for every frame a session backend emits, one per `op` in the
 * StreamEnvelope union. The `op` string vocabulary lives ONLY here, so a backend
 * (the local session-store, the Richter service) never hand-spells a frame - this
 * mirrors the emit-side `events.*` constructors in ./protocol that own the event
 * vocabulary. Each returns a typed StreamEnvelope the shared client decodes.
 */
export const frames = {
  /** One replayed or live-tailed session event. */
  event: (event: SessionEvent): StreamEnvelope => ({ op: "event", event }),
  /** Marks the end of the replay snapshot; live tail follows. */
  replayComplete: (): StreamEnvelope => ({ op: "replay.complete" }),
  /** Acknowledges a control command, optionally correlated by requestId. */
  commandResult: (command: string, requestId?: string): StreamEnvelope => ({
    op: "command.result",
    command,
    ...(requestId !== undefined ? { requestId } : {}),
  }),
  /** Reports a stream-level error, optionally correlated by requestId. */
  error: (error: string, requestId?: string): StreamEnvelope => ({
    op: "error",
    error,
    ...(requestId !== undefined ? { requestId } : {}),
  }),
} as const;
