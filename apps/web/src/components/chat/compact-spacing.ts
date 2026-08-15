import { READ_ONLY_TOOL_NAMES } from "@belay/session";
import type { TranscriptRow } from "../../transcript-rows";

/**
 * The compact transcript's TYPE TAXONOMY + spacing derivation (plan 58): a pure, presentation-only
 * projection that decides how compact rows group into blocks. In compact mode a run of same-TYPE rows
 * reads as one flush block, and a type change opens exactly one blank-line spacer. `compactTypeKey`
 * names a row's type; `compactLeadingGaps` turns an ordered row list into the per-row leading-gap flags
 * the virtualizer applies.
 *
 * It owns ONLY the spacing taxonomy - what counts as "the same type" for grouping. It does NOT own how
 * a single row projects to its one-line form (that is `compact-display.ts`), nor read-only membership
 * (that is `@belay/session`, reused here so compact grouping can't drift from concurrent dispatch).
 *
 * Tools are the exception to keying by `Message.kind`:
 *  - MCP tools (the `mcp` gateway, or a passthrough `mcp__*` name) key by their own name and are ALWAYS
 *    their own type - never folded into the read-only group, regardless of read-only status.
 *  - Every other read-only tool shares the single `readonly` key (matching `readOnlyToolBatches`), so a
 *    run of exploration tools - and a `tool_batch` - sits flush.
 *  - Any other (mutating) tool keys by its name, so consecutive same-named calls (edit, edit) sit flush
 *    while a different tool name opens a gap.
 */

/** The read-only bucket key: every non-MCP read-only tool (and a `tool_batch`) shares this one type. */
const READ_ONLY_KEY = "readonly";

/** True for a tool routed through MCP: the single `mcp` gateway tool, or a passthrough `mcp__*` name. */
function isMcpToolName(name: string): boolean {
  return name === "mcp" || name.startsWith("mcp__");
}

/**
 * The compact type key for a tool by NAME. MCP is checked FIRST so an MCP tool is always its own type,
 * even if a future MCP tool were read-only; then the shared read-only bucket; else the tool's own name.
 */
export function toolTypeKey(name: string): string {
  if (isMcpToolName(name)) {
    return `mcp:${name}`;
  }
  if (READ_ONLY_TOOL_NAMES.has(name)) {
    return READ_ONLY_KEY;
  }
  return `tool:${name}`;
}

/**
 * A compact row's type key: a `tool_batch` is always the read-only bucket (it is only ever a run of
 * read-only tools); a `tool` message keys by tool name (see {@link toolTypeKey}); every other row keys
 * by its `Message.kind`.
 */
export function compactTypeKey(row: TranscriptRow): string {
  if (row.kind === "tool_batch") {
    return READ_ONLY_KEY;
  }
  if (row.kind === "working") {
    return "working";
  }
  const message = row.message;
  if (message.kind === "tool") {
    return toolTypeKey(message.name);
  }
  return message.kind;
}

/**
 * Per-row leading-gap flags for a compact transcript: `false` for the first row and for any row that
 * shares a type key with the previous row; `true` (one blank-line spacer) on a type change.
 */
export function compactLeadingGaps(rows: readonly TranscriptRow[]): boolean[] {
  const gaps: boolean[] = [];
  let previousKey: string | undefined;
  for (const row of rows) {
    const key = compactTypeKey(row);
    gaps.push(previousKey !== undefined && key !== previousKey);
    previousKey = key;
  }
  return gaps;
}
