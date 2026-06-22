import { Schema } from "effect";

/**
 * The Richter wire, owned here in Effect Schema and shared by every trevor
 * participant (web client + host). It is the single source of the protocol
 * (D-017), grown one event at a time, and the decode boundary for untrusted
 * socket input.
 */

/** Arbitrary JSON object payload carried on a session event. */
const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/** One durable, ordered event in a Richter session stream. */
export const SessionEvent = Schema.Struct({
  createdAt: Schema.String,
  eventId: Schema.String,
  payload: JsonObject,
  producerId: Schema.String,
  seq: Schema.Number,
  sessionId: Schema.String,
  type: Schema.String,
});
export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>;

/**
 * Server -> client WebSocket envelopes (op-tagged). Only the ops in use are
 * modelled; unknown ops fail decode and are ignored by clients, preserving
 * forward-compatibility as Richter adds envelope kinds.
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
