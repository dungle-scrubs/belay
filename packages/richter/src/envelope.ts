import { SessionEvent } from "@trevor/session";
import { Schema } from "effect";

/**
 * The Richter wire envelope (op-tagged) that wraps session events on the
 * WebSocket. This is Richter-specific framing: the event shape itself lives in
 * @trevor/session (the shared contract); this only describes how Richter delivers
 * it. Unknown ops fail decode and are ignored by clients, preserving
 * forward-compatibility as Richter adds envelope kinds.
 */

/**
 * Server -> client WebSocket envelopes. Only the ops in use are modelled; unknown
 * ops fail decode and are ignored.
 */
export const ServerEnvelope = Schema.Union(
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
export type ServerEnvelope = Schema.Schema.Type<typeof ServerEnvelope>;

/** Decodes one raw server envelope, returning Either for boundary handling. */
export const decodeServerEnvelope = Schema.decodeUnknownEither(ServerEnvelope);
