import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { clipLine } from "@host/tools/shared";
import type { LspDegraded, LspDiagnostic, LspPosition, LspRange, LspSeverity } from "./contract";

/**
 * Shared display formatting for the LSP tool surface (plan 24 M3 REFACTOR): the one place
 * ranges, severities, sources, degraded outcomes, and file paths render to model-facing text,
 * so lsp_status, lsp_diagnostics, lsp_hover, the symbol tools, and lsp_code_actions cannot
 * drift apart in shape. Positions are the contract's 1-based line:column.
 *
 * Responsible for: rendering LSP contract values as bounded display text.
 * Not for: result shapes and decode (./contract), size caps (./caps), or tool params and
 * dispatch (tools/lsp-*).
 */

/** Longest source/code origin label inside a diagnostic line. */
const MAX_ORIGIN_CHARS = 80;

/** "3:5" - the contract's 1-based line:column. */
export function formatPosition(position: LspPosition): string {
  return `${position.line}:${position.column}`;
}

/** "3:5-3:9", collapsed to "3:5" for an empty range. */
export function formatRange(range: LspRange): string {
  const start = formatPosition(range.start);
  const end = formatPosition(range.end);
  return start === end ? start : `${start}-${end}`;
}

/** One bounded diagnostic line: "3:5-3:9 error [typescript 2304] Cannot find name 'x'". */
export function formatDiagnosticLine(diagnostic: LspDiagnostic): string {
  const origin = [diagnostic.source, diagnostic.code].filter(Boolean).join(" ");
  const label = origin ? ` [${clipLine(origin, MAX_ORIGIN_CHARS)}]` : "";
  return `${formatRange(diagnostic.range)} ${diagnostic.severity}${label} ${diagnostic.message}`;
}

const SEVERITY_ORDER: readonly LspSeverity[] = ["error", "warning", "info", "hint"];

/** "2 errors, 1 warning" in fixed severity order, zeros skipped; "none" when empty. */
export function formatSeverityCounts(diagnostics: readonly LspDiagnostic[]): string {
  const parts = SEVERITY_ORDER.flatMap((severity) => {
    const count = diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
    return count > 0 ? [`${count} ${severity}${count === 1 ? "" : "s"}`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : "none";
}

const DEGRADED_REASON_WORDS: Record<LspDegraded["reason"], string> = {
  unavailable: "unavailable",
  unsupported: "unsupported",
  timeout: "timed out",
  stale: "stale",
  server_error: "error",
};

/** The bounded SUCCESS text a tool returns for a degraded outcome (D-006) - never a throw. */
export function describeDegraded(outcome: LspDegraded): string {
  return `language server ${DEGRADED_REASON_WORDS[outcome.reason]}: ${outcome.detail}`;
}

/** A file uri (or path) as a workspace-relative display path when inside the root. */
export function displayPath(uriOrPath: string, workspaceRoot: string): string {
  let path = uriOrPath;
  if (uriOrPath.startsWith("file://")) {
    try {
      path = fileURLToPath(uriOrPath);
    } catch {
      return uriOrPath; // a garbage uri displays as-is rather than throwing
    }
  }
  if (!isAbsolute(path)) {
    return path;
  }
  const relativePath = relative(workspaceRoot, path);
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : path;
}
