import { asRecord } from "@host/boot/decode";
import { capItems, MAX_LSP_WORKSPACE_SYMBOLS } from "@host/lsp/caps";
import { type LspWorkspaceSymbol, lspSymbolKindName, rangeFromLsp } from "@host/lsp/contract";
import { describeDegraded, displayPath, formatPosition } from "@host/lsp/format";
import type { LspManager } from "@host/lsp/manager";
import { Schema } from "effect";
import { lspWorkspaceRoot, unsupportedCapability } from "./lsp-shared";
import { clamp, simpleTool, toolInput } from "./shared";
import type { Tool } from "./types";

/**
 * The model-facing `lsp_workspace_symbols` tool (plan 24 M4): query-driven lookup of NAMED
 * declarations across the workspace (D-002). The query is REQUIRED and non-empty - symbol
 * catalogs are exposed only through scoped queries, never dumped whole (the D-003 no-dump
 * discipline) - and matches are capped at the clamped limit. This is a symbol-NAME lookup;
 * literal text and regex search stay on grep/ast_grep. Degraded outcomes are bounded SUCCESS
 * text (D-006).
 *
 * Responsible for: the lsp_workspace_symbols tool definition - params, the required-query
 * gate, symbol decode, and capped location rendering.
 * Not for: lifecycle (@host/lsp/manager) or shared formatting (@host/lsp/format).
 */

/** Matches returned when the model names no limit. */
const DEFAULT_LIMIT = 20;

const Params = Schema.Struct({
  query: Schema.String.annotations({
    description: "Symbol-name query (required, non-empty), e.g. 'buildTurn' or 'SessionStore'.",
  }),
  limit: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: 1, maximum: MAX_LSP_WORKSPACE_SYMBOLS },
    }),
  ).annotations({
    description: `Max matches, clamped to [1, ${MAX_LSP_WORKSPACE_SYMBOLS}] (default ${DEFAULT_LIMIT}).`,
  }),
});

export type LspWorkspaceSymbolsArgs = typeof Params.Type;

/** One wire SymbolInformation/WorkspaceSymbol to the contract shape. */
function decodeSymbol(raw: unknown): LspWorkspaceSymbol | null {
  const record = asRecord(raw);
  if (!record || typeof record.name !== "string") {
    return null;
  }
  const location = asRecord(record.location);
  return {
    name: record.name,
    kind: lspSymbolKindName(record.kind),
    ...(typeof record.containerName === "string" && record.containerName.length > 0
      ? { containerName: record.containerName }
      : {}),
    location: {
      file: typeof location?.uri === "string" ? location.uri : "",
      range: rangeFromLsp(location?.range),
    },
  };
}

function symbolLine(symbol: LspWorkspaceSymbol, root: string): string {
  const where = `${displayPath(symbol.location.file, root)}:${formatPosition(symbol.location.range.start)}`;
  const container = symbol.containerName ? ` (in ${symbol.containerName})` : "";
  return `- ${symbol.kind} ${symbol.name} ${where}${container}`;
}

/** Builds the lsp_workspace_symbols tool over a manager; tools/index.ts binds the singleton. */
export function buildLspWorkspaceSymbolsTool(manager: LspManager): Tool<LspWorkspaceSymbolsArgs> {
  return simpleTool({
    name: "lsp_workspace_symbols",
    description:
      "Find NAMED declarations (functions, classes, types, constants) across the workspace by " +
      "symbol-name query; returns capped name/kind/location matches. For literal text or regex " +
      "search, grep and ast_grep remain the right tools.",
    params: Params,
    readOnly: true,
    capped: true,
    execute: async (args) => {
      const query = args.query.trim();
      if (query.length === 0) {
        return toolInput(
          "lsp_workspace_symbols needs a non-empty query - symbol catalogs are query-scoped, never dumped whole",
        );
      }
      const limit = clamp(args.limit, 1, MAX_LSP_WORKSPACE_SYMBOLS, DEFAULT_LIMIT);
      const acquired = await manager.acquire();
      if (acquired.kind === "degraded") {
        return describeDegraded(acquired);
      }
      const unsupported = unsupportedCapability(acquired, "workspaceSymbolProvider");
      if (unsupported) {
        return describeDegraded(unsupported);
      }
      const outcome = await manager.request("workspace/symbol", { query });
      if (outcome.kind === "degraded") {
        return describeDegraded(outcome);
      }
      const symbols = Array.isArray(outcome.value)
        ? outcome.value.flatMap((entry) => decodeSymbol(entry) ?? [])
        : [];
      if (symbols.length === 0) {
        return `no workspace symbols match "${query}"`;
      }
      const root = lspWorkspaceRoot(manager);
      const capped = capItems(symbols, limit);
      const cut = capped.truncated ? `, showing the first ${limit}` : "";
      const header = `${symbols.length} workspace symbol(s) matching "${query}"${cut}:`;
      return [header, ...capped.items.map((symbol) => symbolLine(symbol, root))].join("\n");
    },
  });
}
