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
