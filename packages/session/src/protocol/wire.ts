import { asAnyNumber, asMaybeString, asString, asStringArray, oneOf } from "../coerce";
import type { SessionEvent } from "../event";

/**
 * The wire-event spec vocabulary: each protocol event is defined ONCE as a table of field
 * specs, and that single definition yields BOTH the decoded TypeScript shape (via
 * {@link WireDecoded}) and the total, permissive decoder (via {@link wireEvent}) - the
 * type and the codec can no longer drift apart. Field decoding reuses the shared
 * `../coerce` leaf, so leniency semantics are identical to the hand-written decoders
 * these specs replaced: every decode is TOTAL (malformed input coerces to a safe default,
 * it never throws), matching the envelope-level contract that unknown/garbled events
 * degrade rather than break replay.
 *
 * Responsible for: the field-spec combinators, presence semantics, the per-event decode
 * driver, and the decoded-shape type derivation.
 * Not for: the event tables themselves (decode.ts) or nested value decoders
 * (coerceUsage & friends stay beside their event tables).
 */

/**
 * How a decoded field lands on the decoded event object - the vocabulary of key-presence
 * semantics the legacy decoders used:
 * - `always`: the key is always present (its value may be `undefined`).
 * - `definedKey`: the key is present only when the decoded value is not `undefined`.
 * - `truthyKey`: the key is present only when the decoded value is truthy (an empty
 *   string or 0 reads as absent) - the `...(x ? { k: x } : {})` idiom.
 * - `nonEmptyKey`: the key is present only when the decoded array has members.
 */
export type WirePresence = "always" | "definedKey" | "truthyKey" | "nonEmptyKey";

export interface WireField<A, P extends WirePresence = WirePresence> {
  readonly presence: P;
  /** Total decode of one payload field; `event` carries the envelope for id fallbacks. */
  readonly decode: (value: unknown, event: SessionEvent) => A;
}

type WireFields = Record<string, WireField<unknown, WirePresence>>;

/** Array-typed field values surface as readonly arrays on the decoded shape, matching the
 *  hand-written unions these specs replace (decoded events are read-only wire views). */
type WireValue<A> = A extends readonly (infer E)[] ? readonly E[] : A;

/** The decoded shape one field-spec table derives: an `always` field whose decode can
 *  never yield `undefined` is a required key; everything else is an optional key (matching
 *  the hand-written unions these replace, where an always-present-but-maybe-undefined key
 *  was typed `k?: T`), holding the decoded value minus `undefined`. */
export type WireShape<S extends WireFields> = {
  readonly [K in keyof S as S[K] extends WireField<infer A, "always">
    ? undefined extends A
      ? never
      : K
    : never]: S[K] extends WireField<infer A, WirePresence> ? WireValue<A> : never;
} & {
  readonly [K in keyof S as S[K] extends WireField<infer A, "always">
    ? undefined extends A
      ? K
      : never
    : K]?: S[K] extends WireField<infer A, WirePresence> ? Exclude<WireValue<A>, undefined> : never;
};

export interface WireEvent<T extends string, S extends WireFields> {
  readonly type: T;
  readonly decode: (event: SessionEvent) => { readonly type: T } & WireShape<S>;
}

/**
 * Defines one wire event: its type tag plus a field-spec table. `finish` is the
 * cross-field escape hatch (e.g. a decode-time cap that forces a sibling flag); it sees
 * the decoded draft and the raw payload and returns the value to emit.
 */
export function wireEvent<T extends string, S extends WireFields>(
  type: T,
  fields: S,
  finish?: (
    draft: { type: T } & Record<string, unknown>,
    payload: Record<string, unknown>,
    event: SessionEvent,
  ) => { type: T } & Record<string, unknown>,
): WireEvent<T, S> {
  return {
    type,
    decode: (event) => {
      const payload = event.payload;
      const draft: { type: T } & Record<string, unknown> = { type };
      for (const key of Object.keys(fields)) {
        const spec = fields[key] as WireField<unknown, WirePresence>;
        const value = spec.decode(payload[key], event);
        switch (spec.presence) {
          case "always":
            draft[key] = value;
            break;
          case "definedKey":
            if (value !== undefined) {
              draft[key] = value;
            }
            break;
          case "truthyKey":
            if (value) {
              draft[key] = value;
            }
            break;
          case "nonEmptyKey":
            if (Array.isArray(value) && value.length > 0) {
              draft[key] = value;
            }
            break;
        }
      }
      const finished = finish ? finish(draft, payload, event) : draft;
      return finished as { readonly type: T } & WireShape<S>;
    },
  };
}

/** The decoded union one event table derives. */
export type WireDecoded<E> =
  E extends WireEvent<infer T, infer S> ? { readonly type: T } & WireShape<S> : never;

// --- field combinators (presence x coercion, over the shared ../coerce leaf) ---

export const field = {
  /** A string, `fallback` (default "") for any non-string. Key always present. */
  string: (fallback = ""): WireField<string, "always"> => ({
    presence: "always",
    decode: (value) => asString(value, fallback),
  }),

  /** A string falling back to the event's own id - the correlation-id idiom (runId,
   *  requestId, callId, foldId, questionId): a forward-compat event still correlates
   *  rather than collapsing distinct runs together. Key always present. */
  idWithEventFallback: (): WireField<string, "always"> => ({
    presence: "always",
    decode: (value, event) => asString(value, event.eventId),
  }),

  /** Any string (empty included), else `undefined`. Key always present. */
  optString: (): WireField<string | undefined, "always"> => ({
    presence: "always",
    decode: (value) => asMaybeString(value),
  }),

  /** Any string, key present only when non-empty - the `...(x ? { k: x } : {})` idiom. */
  truthyString: (): WireField<string | undefined, "truthyKey"> => ({
    presence: "truthyKey",
    decode: (value) => asMaybeString(value),
  }),

  /** Any string (empty included), key present only when the payload carried a string -
   *  the `...(typeof x === "string" ? { k: x } : {})` idiom. */
  stringKey: (): WireField<string | undefined, "definedKey"> => ({
    presence: "definedKey",
    decode: (value) => asMaybeString(value),
  }),

  /** Any number (NaN/Infinity preserved), `fallback` (default 0) for a non-number.
   *  Key always present. */
  number: (fallback = 0): WireField<number, "always"> => ({
    presence: "always",
    decode: (value) => asAnyNumber(value, fallback),
  }),

  /** A number, else `undefined` - the key stays PRESENT with an undefined value. */
  numberOrUndefined: (): WireField<number | undefined, "always"> => ({
    presence: "always",
    decode: (value) => (typeof value === "number" ? value : undefined),
  }),

  /** A number, key present only when the payload carried one. */
  numberKey: (): WireField<number | undefined, "definedKey"> => ({
    presence: "definedKey",
    decode: (value) => (typeof value === "number" ? value : undefined),
  }),

  /** A FINITE number, key present only then - for fields where a defaulted 0 would
   *  misread (a reset at the epoch, a 0% utilization). */
  finiteNumberKey: (): WireField<number | undefined, "definedKey"> => ({
    presence: "definedKey",
    decode: (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
  }),

  /** Strict `=== true` boolean. Key always present. */
  boolean: (): WireField<boolean, "always"> => ({
    presence: "always",
    decode: (value) => value === true,
  }),

  /** The tolerant enum decode over the shared `oneOf`. Key always present. */
  oneOf: <T extends string>(options: readonly T[], fallback: T): WireField<T, "always"> => ({
    presence: "always",
    decode: (value) => oneOf(options, value, fallback),
  }),

  /** An array's string members (non-strings dropped), `[]` for a non-array.
   *  Key always present. */
  stringList: (): WireField<string[], "always"> => ({
    presence: "always",
    decode: (value) => asStringArray(value),
  }),

  /** A string list, key present only when it has members. */
  nonEmptyStringList: (): WireField<string[], "nonEmptyKey"> => ({
    presence: "nonEmptyKey",
    decode: (value) => asStringArray(value),
  }),

  /** The raw payload value, untouched. Key always present. */
  raw: (): WireField<unknown, "always"> => ({
    presence: "always",
    decode: (value) => value,
  }),

  /** The raw payload value, key present only when the payload carried one. */
  rawKey: (): WireField<unknown, "definedKey"> => ({
    presence: "definedKey",
    decode: (value) => value,
  }),

  /** Delegates to a nested value decoder (coerceUsage & friends). Key always present. */
  via: <A>(decode: (value: unknown) => A): WireField<A, "always"> => ({
    presence: "always",
    decode: (value) => decode(value),
  }),

  /** Delegates to a nested decoder, key present only when it yields a truthy value; a
   *  null/undefined result reads as undefined so the decoded type never carries `null`. */
  viaTruthy: <A>(
    decode: (value: unknown) => A | null | undefined,
  ): WireField<NonNullable<A> | undefined, "truthyKey"> => ({
    presence: "truthyKey",
    decode: (value) => (decode(value) ?? undefined) as NonNullable<A> | undefined,
  }),

  /** The escape hatch: an explicit decode + presence for a one-off field semantic. */
  custom: <A, P extends WirePresence>(
    presence: P,
    decode: (value: unknown, event: SessionEvent) => A,
  ): WireField<A, P> => ({ presence, decode }),
} as const;
