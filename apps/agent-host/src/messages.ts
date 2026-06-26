/**
 * Neutral host message helpers reached from across the host (not just tools): turning an
 * unknown thrown/rejected value into a displayable message string. This owns the
 * unknown -> string normalization; it is NOT tool-specific (the tool error envelope lives in
 * tools/shared.ts) and it does NOT format log lines (that is log.ts).
 */

/** Normalizes an unknown thrown value to its message string. */
export function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
