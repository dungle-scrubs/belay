/**
 * Neutral host message helpers reached from across the host (not just tools): turning an
 * unknown thrown/rejected value into a displayable message string. The normalization itself is
 * the monorepo-wide `errorMessage` in @trevor/session (shared with web + cli, which cannot import
 * this host module); the host keeps the short `msg` name its ~20 callsites use by re-exporting it.
 * This module is NOT tool-specific (the tool error envelope lives in tools/shared.ts) and does NOT
 * format log lines (that is log.ts).
 *
 * Responsible for: re-exporting the shared error->message normalizer as the host's `msg` helper.
 * Not for: the tool error envelope (tools/shared.ts) or log-line formatting (log.ts).
 */

import { errorMessage } from "@trevor/session";

/** Normalizes an unknown thrown value to its message string (the shared `errorMessage`). */
export const msg = errorMessage;
