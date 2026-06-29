/**
 * The shared permissive coercion leaf: the small family of "read an untrusted/forward-compat wire
 * value into a safe typed default" helpers that the protocol decoders (protocol-decode, model-source,
 * model-preferences, provider-question, connectivity) each used to re-spell. Zero-dependency and
 * isomorphic, so every decoder imports the SAME semantics instead of subtly-disagreeing local copies.
 *
 * Two string variants exist on purpose - they are NOT interchangeable:
 *   - {@link asOptString} keeps a value only when it is a NON-EMPTY string (an empty string reads as
 *     absent). It is the right default for richness fields where "" carries no information.
 *   - {@link asMaybeString} keeps ANY string, empty included. It is the right default where the empty
 *     string is a meaningful distinct value to preserve.
 * Pick the one matching the call site's original behavior; do not swap them.
 */

/** Reads a string, or `fallback` (default "") for any non-string. */
export const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/** Reads a NON-EMPTY string, or undefined (an empty string reads as absent). */
export const asOptString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** Reads ANY string (empty included) as itself, or undefined for a non-string. */
export const asMaybeString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Reads a finite number, or `fallback` (default 0) for anything non-finite (NaN/Infinity included). */
export const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Reads any number (NaN/Infinity included) as itself, or `fallback` (default 0) for a non-number.
 * Looser than {@link asNumber}: it does NOT require finiteness, preserving the char-count decoders'
 * legacy behavior where a stray NaN/Infinity off the wire passed through unchanged.
 */
export const asAnyNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" ? value : fallback;

/**
 * Reads any non-null object (an array included) as a record, or `{}` for a primitive/null. Looser
 * than {@link asOptRecord}: it does NOT reject arrays, so a caller that only reads named properties
 * (which read as undefined on an array) keeps the legacy decoder behavior exactly.
 */
export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Reads a plain object as a record, or undefined for anything else (arrays and null included). */
export const asOptRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Reads an array's string members (dropping non-strings), or `[]` for a non-array. */
export const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

/** Returns `v` when it is one of `opts`, else `fallback` - the tolerant enum decode. */
export function oneOf<T extends string>(opts: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (opts as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Like {@link oneOf} but yields null (not a fallback member) for an unrecognised value. */
export function oneOfOrNull<T extends string>(opts: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (opts as readonly string[]).includes(v) ? (v as T) : null;
}
