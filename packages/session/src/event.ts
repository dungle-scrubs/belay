import { Schema } from "effect";

/**
 * The session event: the durable, ordered unit every Trevor participant produces
 * and replays. Owned here in Effect Schema as the decode boundary for untrusted
 * socket input, and shared by every participant (web client + host) and every
 * transport (local or Richter) - the event shape is the contract; the transport
 * that carries it is a plug-in (see ./transport).
 */

/** Arbitrary JSON object payload carried on a session event. */
const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/** One durable, ordered event in a session stream. */
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
