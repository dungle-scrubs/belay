import type { LspServerStatus } from "@host/lsp/contract";
import type { LspManager } from "@host/lsp/manager";
import { Schema } from "effect";
import { clipLine, simpleTool } from "./shared";
import type { Tool } from "./types";

/**
 * The model-facing `lsp_status` tool (plan 24 M3): renders the LSP runtime manager's
 * per-workspace status snapshots - the D-008 vocabulary (configured/missing/unavailable/
 * initializing/ready/stale/error/timeout) plus last request, last error (bounded, one line),
 * and the restart count - as flat text. Read-only (D-007): it only reads manager state and
 * never spawns a server.
 *
 * Responsible for: the lsp_status tool definition and its status-line rendering.
 * Not for: lifecycle state itself (@host/lsp/manager) or the singleton wiring
 * (@host/lsp/host-runtime).
 */

// A no-arg tool: an EMPTY object params schema. The explicit `jsonSchema` annotation pins the
// clean `{ type: "object", properties: {} }` shape (the doctor-tool precedent - a bare
// Schema.Struct({}) leaks an `anyOf` with a relative `$id` OpenAI-compatible providers reject).
const Params = Schema.Struct({}).annotations({
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
});

/** Longest rendered last-error slice (bounded + collapsed onto one line). */
const MAX_STATUS_ERROR_CHARS = 300;

function statusLine(status: LspServerStatus): string {
  const parts = [
    `- ${status.workspaceRoot}: ${status.status}`,
    ...(status.server ? [`server ${status.server}`] : []),
    `restarts ${status.restarts}`,
  ];
  if (status.staleAgeMs !== undefined) {
    parts.push(`quiet for ${Math.round(status.staleAgeMs / 1000)}s`);
  }
  if (status.lastRequestMethod) {
    const at =
      status.lastRequestAt !== undefined
        ? ` at ${new Date(status.lastRequestAt).toISOString()}`
        : "";
    parts.push(`last request ${status.lastRequestMethod}${at}`);
  }
  if (status.lastError) {
    parts.push(`last error: ${clipLine(status.lastError, MAX_STATUS_ERROR_CHARS)}`);
  }
  return parts.join(" · ");
}

/** Builds the lsp_status tool over a manager; tools/index.ts binds the host singleton. */
export function buildLspStatusTool(manager: LspManager): Tool<typeof Params.Type> {
  return simpleTool({
    name: "lsp_status",
    description:
      "Report the workspace language server's health: status (configured, missing, unavailable, " +
      "initializing, ready, stale, error, or timeout), last request, last error, and restart " +
      "count. Read-only; does not start a server.",
    params: Params,
    readOnly: true,
    capped: true,
    execute: () => {
      const entries = manager.statusSnapshot();
      const header = `${entries.length} LSP workspace(s):`;
      return [header, ...entries.map(statusLine)].join("\n");
    },
  });
}
