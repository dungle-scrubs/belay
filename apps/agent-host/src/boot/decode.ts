/**
 * Tiny shared narrowing helpers for the host's tolerant raw-input decoders (plan 23; hoisted
 * from mcp/ in the plan 24 simplify pass): the "is this a plain object?" and "is this a usable
 * string?" guards every tolerant decoder needs - MCP config/capabilities/content/transport,
 * the LSP wire decoders, adapter manifest sniffing - kept in one place beside ./coerce instead
 * of re-spelled per module.
 *
 * Responsible for: asRecord / asNonEmptyString narrowing for tolerant raw-input decoding.
 * Not for: numeric coercions (./coerce) or any protocol semantics.
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
