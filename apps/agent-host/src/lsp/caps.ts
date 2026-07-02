import { type BoundedText, boundedText } from "@host/tools/shared";

/**
 * Result-size caps for the LSP subsystem (plan 24 M1). Every LSP payload the model or the UI
 * sees is bounded (D-006): counts for list-shaped results (diagnostics, symbols, locations,
 * proposals) and character sizes for text-shaped ones (hover markdown, proposal previews,
 * server-log tails, degraded details). The text caps all fit inside the host's tool-output
 * ceiling (tools/shared MAX_OUTPUT), and cuts are marked with the shared truncation notice so
 * an LSP result reads like any other capped tool result.
 *
 * Responsible for: the LSP count/text caps and the generic capItems/capText helpers.
 * Not for: result shapes and degraded outcomes - ./contract owns those.
 */

/** Most diagnostics one tool result returns (per file or per workspace summary). */
export const MAX_LSP_DIAGNOSTICS = 50;

/** Most published diagnostics the client retains per file; later ones are dropped at the door. */
export const MAX_LSP_STORED_DIAGNOSTICS_PER_FILE = 200;

/** Most files the client's published-diagnostics store retains; the oldest entry (insertion
 *  order) is evicted on overflow, so a long session cannot grow the store unbounded. */
export const MAX_LSP_STORED_FILES = 100;

/** Longest single diagnostic message (one-line clipped). */
export const MAX_LSP_DIAGNOSTIC_MESSAGE_CHARS = 400;

/** Longest hover content (markdown or plain text). */
export const MAX_LSP_HOVER_CHARS = 4_000;

/** Most document-symbol nodes one outline returns, counted across all nesting levels. */
export const MAX_LSP_DOCUMENT_SYMBOLS = 200;

/** Most workspace-symbol matches one query returns. */
export const MAX_LSP_WORKSPACE_SYMBOLS = 50;

/** Most code-action proposals one request returns. */
export const MAX_LSP_CODE_ACTIONS = 20;

/** Longest serialized edit preview per code-action proposal (D-005: text, never applied). */
export const MAX_LSP_PROPOSAL_TEXT_CHARS = 4_000;

/** Longest retained server stderr tail (crash details, status snapshots). */
export const MAX_LSP_SERVER_LOG_CHARS = 2_048;

/** Longest degraded-outcome detail line (D-006 results stay small). */
export const MAX_LSP_DEGRADED_DETAIL_CHARS = 400;

export interface CappedItems<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
}

/** Keeps the first `max` items (order preserved) and flags whether anything was cut. */
export function capItems<T>(items: readonly T[], max: number): CappedItems<T> {
  if (items.length <= max) {
    return { items, truncated: false };
  }
  return { items: items.slice(0, max), truncated: true };
}

export type CappedText = BoundedText;

/** Cuts text at `maxChars` with the host's standard truncation marker, flagging the cut - the
 *  shared tools/shared boundedText under the LSP subsystem's established name. */
export const capText: (text: string, maxChars: number) => CappedText = boundedText;
