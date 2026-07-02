import { clipLine } from "@host/tools/shared";
import { MAX_LSP_DEGRADED_DETAIL_CHARS } from "./caps";

/**
 * The stable LSP result contract (plan 24 M1): the shapes every read-only LSP tool (D-002 -
 * status, diagnostics, hover, document symbols, workspace symbols, code-action proposals)
 * returns, plus the typed DEGRADED outcomes (D-006). Degradation is data, not control flow: a
 * missing, unsupported, slow, stale, or erroring server produces an {@link LspDegraded} result
 * variant the tool renders as normal bounded text - an LSP failure never throws through a
 * turn. Positions are 1-based line/column (matching how read/grep display locations); the
 * 0-based LSP wire positions convert at the decode boundary ({@link rangeFromLsp}).
 *
 * Read-only registration (D-007): the six tool names live here as {@link LSP_TOOL_DESCRIPTORS},
 * each pinned readOnly. They join the cross-surface packages/session TOOL_DESCRIPTORS table
 * only as each tool def lands (M3-M5), because that table's parity test pins it 1:1 against
 * the host's REAL tool defs; until then this contract (and its forward-guard test) is the
 * read-only declaration.
 *
 * Responsible for: the LSP result shapes, the degraded-outcome variants and constructors, the
 * severity/symbol-kind vocabularies, and the read-only LSP tool descriptor table.
 * Not for: result-size caps (./caps), wire transport (./client), or lifecycle (./manager).
 */

/** A 1-based document position (line 1 = first line, column 1 = first character). */
export interface LspPosition {
  readonly line: number;
  readonly column: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/** A workspace location: a file path plus the range inside it. */
export interface LspLocation {
  readonly file: string;
  readonly range: LspRange;
}

export type LspSeverity = "error" | "warning" | "info" | "hint";

export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity: LspSeverity;
  /** The producing analyzer ("typescript", "eslint"), when the server names one. */
  readonly source?: string;
  readonly message: string;
  /** The server's diagnostic code ("2304"), when present, as text. */
  readonly code?: string;
}

/** One file's pulled diagnostics (D-003: returned from an explicit tool call, never ambient). */
export interface LspFileDiagnostics {
  readonly file: string;
  readonly diagnostics: readonly LspDiagnostic[];
  readonly truncated: boolean;
}

/** Hover content as bounded text (markdown or plain, per the server). */
export interface LspHover {
  readonly text: string;
  readonly truncated: boolean;
  readonly range?: LspRange;
}

/** One node of a document outline; kinds are readable names ({@link lspSymbolKindName}). */
export interface LspDocumentSymbol {
  readonly name: string;
  readonly kind: string;
  readonly detail?: string;
  readonly range: LspRange;
  readonly children: readonly LspDocumentSymbol[];
}

export interface LspWorkspaceSymbol {
  readonly name: string;
  readonly kind: string;
  readonly containerName?: string;
  readonly location: LspLocation;
}

/**
 * A code action as a read-only PROPOSAL (D-005): title/kind/range identify it, and any edits
 * arrive serialized as reviewable text - the host never applies a workspace edit.
 */
export interface LspCodeActionProposal {
  readonly title: string;
  readonly kind?: string;
  readonly range?: LspRange;
  /** The action's edits rendered as bounded reviewable text; absent when the action has none. */
  readonly editPreview?: string;
  readonly isPreferred?: boolean;
}

/** The lifecycle states a workspace's language server reports (D-001, D-008). */
export type LspServerStatusKind =
  | "configured"
  | "missing"
  | "unavailable"
  | "initializing"
  | "ready"
  | "stale"
  | "error"
  | "timeout";

/** Bounded counts over a live server's STORED published diagnostics (plan 24 M8): how many
 *  files currently carry diagnostics and the error/warning totals - counts only, never a
 *  message or a path, so the Doctor surface stays redaction-safe by construction. */
export interface LspStoredDiagnosticsSummary {
  readonly files: number;
  readonly errors: number;
  readonly warnings: number;
}

/** One workspace root's server status snapshot (the lsp_status/Doctor projection). */
export interface LspServerStatus {
  readonly workspaceRoot: string;
  /** The matched adapter's display name; absent when no adapter matches (status "missing"). */
  readonly server?: string;
  readonly status: LspServerStatusKind;
  readonly lastRequestMethod?: string;
  readonly lastRequestAt?: number;
  readonly lastError?: string;
  /** Milliseconds since the last successful server response, present once past the threshold. */
  readonly staleAgeMs?: number;
  /** Crash-restart count consumed against the bounded restart budget. */
  readonly restarts: number;
  /** Stored-diagnostics counts (plan 24 M8); absent until a live server has published any. */
  readonly diagnostics?: LspStoredDiagnosticsSummary;
}

/** Why a result degraded instead of answering (D-006). */
export const LSP_DEGRADED_REASONS = [
  "unavailable",
  "unsupported",
  "timeout",
  "stale",
  "server_error",
] as const;

export type LspDegradedReason = (typeof LSP_DEGRADED_REASONS)[number];

/**
 * The degraded result variant: a plain value a tool renders as normal bounded text. Never a
 * thrown turn failure - LSP is an aid, not a dependency (D-006).
 */
export interface LspDegraded {
  readonly kind: "degraded";
  readonly reason: LspDegradedReason;
  readonly detail: string;
}

export interface LspOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

/** Every LSP query answers with one of these; degradation is a variant, not an exception. */
export type LspOutcome<T> = LspOk<T> | LspDegraded;

/** Constructs the degraded variant with the detail clipped to one bounded line. */
export function degraded(reason: LspDegradedReason, detail: string): LspDegraded {
  return { kind: "degraded", reason, detail: clipLine(detail, MAX_LSP_DEGRADED_DETAIL_CHARS) };
}

export function ok<T>(value: T): LspOk<T> {
  return { kind: "ok", value };
}

export function isLspDegraded(outcome: LspOutcome<unknown>): outcome is LspDegraded {
  return outcome.kind === "degraded";
}

/** Decodes one 0-based LSP wire position to the 1-based contract; garbage degrades to 1:1. */
function positionFromLsp(raw: unknown): LspPosition {
  const record =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  const line = typeof record?.line === "number" && record.line >= 0 ? record.line + 1 : 1;
  const column =
    typeof record?.character === "number" && record.character >= 0 ? record.character + 1 : 1;
  return { line, column };
}

/** Decodes one LSP wire range ({ start, end } of 0-based positions); garbage degrades to 1:1. */
export function rangeFromLsp(raw: unknown): LspRange {
  const record =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  return { start: positionFromLsp(record?.start), end: positionFromLsp(record?.end) };
}

/** LSP DiagnosticSeverity (1-4) to the named vocabulary; unknown/absent degrades to "info". */
export function lspSeverityName(raw: unknown): LspSeverity {
  switch (raw) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "info";
  }
}

/** LSP SymbolKind names, indexed by wire value 1-26. */
const SYMBOL_KIND_NAMES = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
] as const;

/** LSP SymbolKind (1-26) to a readable name; unknown degrades to "symbol". */
export function lspSymbolKindName(raw: unknown): string {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 26) {
    return SYMBOL_KIND_NAMES[raw - 1] as string;
  }
  return "symbol";
}

/** The six read-only LSP tools of the first cut (D-002), in registration order. */
export const LSP_TOOL_NAMES = [
  "lsp_status",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_workspace_symbols",
  "lsp_code_actions",
] as const;

export type LspToolName = (typeof LSP_TOOL_NAMES)[number];

export interface LspToolDescriptor {
  readonly name: LspToolName;
  /** Always true: every first-cut LSP tool is a read-only scheduler citizen (D-007). */
  readonly readOnly: true;
}

/** The D-007 declaration each M3-M5 tool def (and its TOOL_DESCRIPTORS entry) must satisfy. */
export const LSP_TOOL_DESCRIPTORS: readonly LspToolDescriptor[] = LSP_TOOL_NAMES.map((name) => ({
  name,
  readOnly: true,
}));
