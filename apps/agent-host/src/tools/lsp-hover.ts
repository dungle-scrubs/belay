import { capText, MAX_LSP_HOVER_CHARS } from "@host/lsp/caps";
import { type LspRange, rangeFromLsp } from "@host/lsp/contract";
import { describeDegraded, formatRange } from "@host/lsp/format";
import type { LspManager } from "@host/lsp/manager";
import { Schema } from "effect";
import {
  fileNotFound,
  loadWorkspaceFile,
  lspWorkspaceRoot,
  openWorkspaceFile,
  toLspPosition,
  unsupportedCapability,
} from "./lsp-shared";
import { simpleTool } from "./shared";
import type { Tool } from "./types";

/**
 * The model-facing `lsp_hover` tool (plan 24 M4): an explicit type/signature/doc lookup at a
 * 1-based file:line:column (D-002). Every call re-syncs the file's CURRENT disk content onto
 * the server before asking (the stale-document rule), positions convert to the 0-based wire at
 * this boundary, and hover content (markdown or plaintext, whatever the server sent) returns
 * capped at MAX_LSP_HOVER_CHARS. Missing file, missing server, timeout - all bounded SUCCESS
 * text (D-006).
 *
 * Responsible for: the lsp_hover tool definition - params, hover-content decode, and rendering.
 * Not for: document sync plumbing (./lsp-shared), lifecycle (@host/lsp/manager), or shared
 * formatting (@host/lsp/format).
 */

const Params = Schema.Struct({
  file: Schema.String.annotations({
    description: "File to look in (workspace-relative or absolute).",
  }),
  line: Schema.Number.annotations({
    jsonSchema: { type: "integer", minimum: 1, description: "1-based line number." },
  }),
  column: Schema.Number.annotations({
    jsonSchema: { type: "integer", minimum: 1, description: "1-based column number." },
  }),
});

export type LspHoverArgs = typeof Params.Type;

/** One MarkedString (string | { language, value }) as plain text. */
function markedString(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "object" && raw !== null) {
    const value = (raw as Record<string, unknown>).value;
    return typeof value === "string" ? value : "";
  }
  return "";
}

/** Decodes an LSP Hover result's contents (MarkupContent | MarkedString | MarkedString[]). */
function hoverContent(raw: unknown): { readonly text: string; readonly range?: LspRange } | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const contents = record.contents;
  const text = (Array.isArray(contents) ? contents.map(markedString) : [markedString(contents)])
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
  if (text.length === 0) {
    return null;
  }
  return { text, ...(record.range !== undefined ? { range: rangeFromLsp(record.range) } : {}) };
}

/** Builds the lsp_hover tool over a manager; tools/index.ts binds the host singleton. */
export function buildLspHoverTool(manager: LspManager): Tool<LspHoverArgs> {
  return simpleTool({
    name: "lsp_hover",
    description:
      "Language-server hover at a 1-based file:line:column - the type signature and docs of " +
      "the symbol there. Content is capped.",
    params: Params,
    readOnly: true,
    capped: true,
    execute: async (args) => {
      const root = lspWorkspaceRoot(manager);
      const loaded = await loadWorkspaceFile(root, args.file);
      if (!loaded) {
        return fileNotFound(args.file, root);
      }
      const acquired = await manager.acquire();
      if (acquired.kind === "degraded") {
        return describeDegraded(acquired);
      }
      const unsupported = unsupportedCapability(acquired, "hoverProvider");
      if (unsupported) {
        return describeDegraded(unsupported);
      }
      openWorkspaceFile(acquired.client, loaded);
      const outcome = await manager.request("textDocument/hover", {
        textDocument: { uri: loaded.uri },
        position: toLspPosition(args.line, args.column),
      });
      if (outcome.kind === "degraded") {
        return describeDegraded(outcome);
      }
      const at = `${loaded.display}:${args.line}:${args.column}`;
      const hover = hoverContent(outcome.value);
      if (!hover) {
        return `no hover information at ${at}`;
      }
      const capped = capText(hover.text, MAX_LSP_HOVER_CHARS);
      const range = hover.range ? ` (${formatRange(hover.range)})` : "";
      return `hover at ${at}${range}:\n${capped.text}`;
    },
  });
}
