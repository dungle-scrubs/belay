/**
 * Tiny shared numeric coercions for the host's tolerant decoders (config files, provider records), so
 * the same "is this a usable positive integer?" guard isn't re-spelled per module. `@belay/session`'s
 * `coerce.ts` is internal to that package (not in its barrel) and lacks the positive+integer semantics,
 * so a small host-local helper is the right home.
 *
 * Responsible for: host-local numeric coercions for tolerant decoders (asPositiveInt).
 */

/** A finite positive number floored to an integer, or undefined for anything else (0, negative, NaN,
 *  Infinity, non-number). */
export function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
