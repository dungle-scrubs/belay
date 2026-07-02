/**
 * Tiny shared narrowing helpers for the MCP modules' tolerant decoders (plan 23): the
 * "is this a plain object?" and "is this a usable string?" guards every decoder needs, kept
 * in one place instead of re-spelled per module (config, capabilities, content, mediation,
 * transport).
 *
 * Responsible for: asRecord / asNonEmptyString narrowing for tolerant MCP decoding.
 * Not for: numeric coercions (@host/boot/coerce) or any MCP semantics.
 */

/** The raw value as a plain record, or undefined for arrays, null, and non-objects. */
export function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

/** The raw value as a non-blank string, or undefined for anything else. */
export function asNonEmptyString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}
