import { asRecord } from "@host/boot/decode";
import { MAX_LSP_DOCUMENT_SYMBOLS } from "@host/lsp/caps";
import { type LspDocumentSymbol, lspSymbolKindName, rangeFromLsp } from "@host/lsp/contract";
import { formatRange } from "@host/lsp/format";
import type { LspManager } from "@host/lsp/manager";
import { Schema } from "effect";
import { runFileLspRequest } from "./lsp-shared";
import { clipLine, simpleTool } from "./shared";
import type { Tool } from "./types";

/**
 * The model-facing `lsp_document_symbols` tool (plan 24 M4): one file's nested outline -
 * symbol names, readable kinds, and 1-based ranges, indented by nesting depth - for orienting
 * in a file without reading all of it (D-002). Decodes both hierarchical DocumentSymbol trees
 * and flat SymbolInformation lists; output is capped at MAX_LSP_DOCUMENT_SYMBOLS counted
 * across all nesting levels. Every degraded outcome is bounded SUCCESS text (D-006).
 *
 * Responsible for: the lsp_document_symbols tool definition - params, symbol decode, and the
 * capped outline rendering.
 * Not for: document sync plumbing (./lsp-shared), lifecycle (@host/lsp/manager), or shared
 * formatting (@host/lsp/format).
 */

const Params = Schema.Struct({
  file: Schema.String.annotations({
    description: "File to outline (workspace-relative or absolute).",
  }),
});

export type LspDocumentSymbolsArgs = typeof Params.Type;

/** Longest rendered symbol detail suffix. */
const MAX_DETAIL_CHARS = 80;

/** One wire symbol (hierarchical DocumentSymbol or flat SymbolInformation) to the contract. */
function decodeSymbol(raw: unknown): LspDocumentSymbol | null {
  const record = asRecord(raw);
  if (!record || typeof record.name !== "string") {
    return null;
  }
  // SymbolInformation carries its range inside `location`; DocumentSymbol carries it directly.
  const location = asRecord(record.location);
  const range = rangeFromLsp(location ? location.range : record.range);
  const children = Array.isArray(record.children)
    ? record.children.flatMap((child) => decodeSymbol(child) ?? [])
    : [];
  return {
    name: record.name,
    kind: lspSymbolKindName(record.kind),
    ...(typeof record.detail === "string" && record.detail.length > 0
      ? { detail: record.detail }
      : {}),
    range,
    children,
  };
}

function decodeSymbols(raw: unknown): readonly LspDocumentSymbol[] {
  return Array.isArray(raw) ? raw.flatMap((entry) => decodeSymbol(entry) ?? []) : [];
}

function countSymbols(symbols: readonly LspDocumentSymbol[]): number {
  return symbols.reduce((total, symbol) => total + 1 + countSymbols(symbol.children), 0);
}

/** Renders the outline depth-first within a shared node budget; returns the lines emitted. */
function renderOutline(
  symbols: readonly LspDocumentSymbol[],
  depth: number,
  budget: { remaining: number },
): string[] {
  const lines: string[] = [];
  for (const symbol of symbols) {
    if (budget.remaining <= 0) {
      break;
    }
    budget.remaining -= 1;
    const detail = symbol.detail ? ` - ${clipLine(symbol.detail, MAX_DETAIL_CHARS)}` : "";
    lines.push(
      `${"  ".repeat(depth)}${symbol.kind} ${symbol.name} ${formatRange(symbol.range)}${detail}`,
    );
    lines.push(...renderOutline(symbol.children, depth + 1, budget));
  }
  return lines;
}

/** Builds the lsp_document_symbols tool over a manager; tools/index.ts binds the singleton. */
export function buildLspDocumentSymbolsTool(manager: LspManager): Tool<LspDocumentSymbolsArgs> {
  return simpleTool({
    name: "lsp_document_symbols",
    description:
      "Outline one file via the language server: nested symbols with kinds and 1-based ranges " +
      "(capped). Useful for orienting in a file without reading all of it.",
    params: Params,
    readOnly: true,
    capped: true,
    execute: async (args) =>
      runFileLspRequest(manager, {
        file: args.file,
        capability: "documentSymbolProvider",
        method: "textDocument/documentSymbol",
        params: ({ loaded }) => ({ textDocument: { uri: loaded.uri } }),
        render: (value, { loaded }) => {
          const symbols = decodeSymbols(value);
          if (symbols.length === 0) {
            return `no symbols reported in ${loaded.display}`;
          }
          const total = countSymbols(symbols);
          const cut =
            total > MAX_LSP_DOCUMENT_SYMBOLS ? `, capped at ${MAX_LSP_DOCUMENT_SYMBOLS}` : "";
          const header = `outline of ${loaded.display} (${total} symbol(s)${cut}):`;
          const budget = { remaining: MAX_LSP_DOCUMENT_SYMBOLS };
          return [header, ...renderOutline(symbols, 0, budget)].join("\n");
        },
      }),
  });
}
