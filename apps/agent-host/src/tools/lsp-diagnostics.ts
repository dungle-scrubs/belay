import { capItems, MAX_LSP_DIAGNOSTICS } from "@host/lsp/caps";
import type { LspDiagnostic, LspSeverity } from "@host/lsp/contract";
import {
  describeDegraded,
  displayPath,
  formatDiagnosticLine,
  formatSeverityCounts,
} from "@host/lsp/format";
import type { LspManager } from "@host/lsp/manager";
import { Schema } from "effect";
import { fileNotFound, loadWorkspaceFile, lspWorkspaceRoot, openWorkspaceFile } from "./lsp-shared";
import { simpleTool } from "./shared";
import type { Tool } from "./types";

/**
 * The model-facing `lsp_diagnostics` tool (plan 24 M3): an explicit PULL (D-003) - diagnostics
 * enter the model context only through this tool's bounded result, never as an ambient feed.
 * With `file` it syncs that file's current disk content onto the server (didOpen/didChange) and
 * waits for its published diagnostics; without it, it summarizes what the server has already
 * reported for files pulled this session (per-file counts + top diagnostics), WITHOUT spawning
 * an idle server. Results are severity-filterable and capped (MAX_LSP_DIAGNOSTICS); every
 * degraded outcome (missing server, silent server, missing file) is bounded SUCCESS text the
 * turn continues past (D-006).
 *
 * Responsible for: the lsp_diagnostics tool definition - params, the file/summary split, and
 * result rendering.
 * Not for: diagnostics collection (@host/lsp/client), lifecycle (@host/lsp/manager), or shared
 * formatting (@host/lsp/format).
 */

const Params = Schema.Struct({
  file: Schema.optional(Schema.String).annotations({
    description:
      "File to pull diagnostics for (workspace-relative or absolute). Omit for a summary of " +
      "files already analyzed this session.",
  }),
  severity: Schema.optional(Schema.Literal("error", "warning", "info", "hint")).annotations({
    description: "Only return diagnostics of this severity.",
  }),
});

export type LspDiagnosticsArgs = typeof Params.Type;

function bySeverity(
  diagnostics: readonly LspDiagnostic[],
  severity: LspSeverity | undefined,
): readonly LspDiagnostic[] {
  return severity
    ? diagnostics.filter((diagnostic) => diagnostic.severity === severity)
    : diagnostics;
}

const severityLabel = (severity: LspSeverity | undefined): string =>
  severity ? `${severity} ` : "";

async function fileDiagnostics(
  manager: LspManager,
  file: string,
  severity: LspSeverity | undefined,
): Promise<string> {
  const root = lspWorkspaceRoot(manager);
  const loaded = await loadWorkspaceFile(root, file);
  if (!loaded) {
    return fileNotFound(file, root);
  }
  const acquired = await manager.acquire();
  if (acquired.kind === "degraded") {
    return describeDegraded(acquired);
  }
  openWorkspaceFile(acquired.client, loaded);
  const published = await acquired.client.waitForDiagnostics(loaded.uri);
  if (published === undefined) {
    return `no diagnostics published for ${loaded.display} (the server reported nothing within the wait window)`;
  }
  const matching = bySeverity(published, severity);
  if (matching.length === 0) {
    return `no ${severityLabel(severity)}diagnostics in ${loaded.display}`;
  }
  const capped = capItems(matching, MAX_LSP_DIAGNOSTICS);
  const cut = capped.truncated ? `, showing the first ${MAX_LSP_DIAGNOSTICS}` : "";
  const header = `${matching.length} ${severityLabel(severity)}diagnostic(s) in ${loaded.display}${cut}:`;
  return [header, ...capped.items.map(formatDiagnosticLine)].join("\n");
}

async function workspaceSummary(
  manager: LspManager,
  severity: LspSeverity | undefined,
): Promise<string> {
  const status = manager.status();
  // Only a live server has anything to summarize; acquiring an idle one would spawn a server
  // just to report an empty store, so an idle root explains itself instead.
  if (status.status !== "ready" && status.status !== "stale") {
    return `no diagnostics pulled yet (language server ${status.status}); pass file to analyze one file`;
  }
  const acquired = await manager.acquire();
  if (acquired.kind === "degraded") {
    return describeDegraded(acquired);
  }
  const root = lspWorkspaceRoot(manager);
  const files = acquired.client
    .diagnosticsSnapshot()
    .map((entry) => ({
      file: displayPath(entry.uri, root),
      diagnostics: bySeverity(entry.diagnostics, severity),
    }))
    .filter((entry) => entry.diagnostics.length > 0)
    .sort((a, b) => b.diagnostics.length - a.diagnostics.length || a.file.localeCompare(b.file));
  if (files.length === 0) {
    return `no ${severityLabel(severity)}diagnostics currently reported (only files pulled through lsp tools are analyzed; pass file to analyze one)`;
  }
  const all = files.flatMap((entry) => entry.diagnostics);
  const lines = [
    `LSP diagnostics summary: ${files.length} file(s), ${all.length} ${severityLabel(severity)}diagnostic(s) (${formatSeverityCounts(all)})`,
  ];
  let budget = MAX_LSP_DIAGNOSTICS;
  for (const entry of files) {
    if (budget <= 0) {
      break;
    }
    lines.push(`${entry.file} (${formatSeverityCounts(entry.diagnostics)}):`);
    const shown = entry.diagnostics.slice(0, budget);
    lines.push(...shown.map((diagnostic) => `  ${formatDiagnosticLine(diagnostic)}`));
    budget -= shown.length;
  }
  const remaining = all.length - Math.min(all.length, MAX_LSP_DIAGNOSTICS);
  if (remaining > 0) {
    lines.push(`…and ${remaining} more not shown`);
  }
  return lines.join("\n");
}

/** Builds the lsp_diagnostics tool over a manager; tools/index.ts binds the host singleton. */
export function buildLspDiagnosticsTool(manager: LspManager): Tool<LspDiagnosticsArgs> {
  return simpleTool({
    name: "lsp_diagnostics",
    description:
      "Pull language-server diagnostics on demand: pass file for one file's current problems " +
      "(fresh from disk), or omit it for a capped per-file summary of files already analyzed " +
      "this session. Optional severity filter (error, warning, info, hint). Results are capped.",
    params: Params,
    readOnly: true,
    capped: true,
    execute: (args) =>
      args.file !== undefined
        ? fileDiagnostics(manager, args.file, args.severity)
        : workspaceSummary(manager, args.severity),
  });
}
