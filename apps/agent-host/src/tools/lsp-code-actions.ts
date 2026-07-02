import {
  capItems,
  capText,
  MAX_LSP_CODE_ACTIONS,
  MAX_LSP_PROPOSAL_TEXT_CHARS,
} from "@host/lsp/caps";
import { rangeFromLsp } from "@host/lsp/contract";
import { describeDegraded, displayPath, formatRange } from "@host/lsp/format";
import type { LspManager } from "@host/lsp/manager";
import { Schema } from "effect";
import {
  fileNotFound,
  loadWorkspaceFile,
  lspWorkspaceRoot,
  openWorkspaceFile,
  toLspPosition,
} from "./lsp-shared";
import { clipLine, simpleTool } from "./shared";
import type { Tool } from "./types";

/**
 * The model-facing `lsp_code_actions` tool (plan 24 M5): the server's code actions for a
 * 1-based line range, returned as read-only PROPOSALS (D-005) - title/kind metadata with any
 * workspace edit SERIALIZED as reviewable text. Nothing is ever applied: workspace edits,
 * rename edits, file operations, and commands are all rendered, never executed; command-only
 * actions carry an explicit unsupported-mutating status. Proposal count and preview size are
 * capped; degraded outcomes are bounded SUCCESS text (D-006).
 *
 * Responsible for: the lsp_code_actions tool definition - params, action decode, and the
 * proposal-only rendering.
 * Not for: document sync plumbing (./lsp-shared), lifecycle (@host/lsp/manager), shared
 * formatting (@host/lsp/format), or APPLYING anything - no edit path exists here by design.
 */

const Params = Schema.Struct({
  file: Schema.String.annotations({
    description: "File to request actions in (workspace-relative or absolute).",
  }),
  startLine: Schema.Number.annotations({
    jsonSchema: { type: "integer", minimum: 1, description: "1-based first line of the range." },
  }),
  startColumn: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: 1, description: "1-based start column (default 1)." },
    }),
  ),
  endLine: Schema.Number.annotations({
    jsonSchema: { type: "integer", minimum: 1, description: "1-based last line of the range." },
  }),
  endColumn: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: 1, description: "1-based end column (default 1)." },
    }),
  ),
});

export type LspCodeActionsArgs = typeof Params.Type;

/** Longest rendered replacement text per edit line. */
const MAX_EDIT_TEXT_CHARS = 120;

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

/** One TextEdit as a reviewable line: `path 1:1-1:5 -> "newText"`. */
function editLine(uri: string, raw: unknown, root: string): string {
  const record = asRecord(raw) ?? {};
  const newText = typeof record.newText === "string" ? record.newText : "";
  const rendered =
    newText.length === 0 ? "(delete)" : `"${clipLine(newText, MAX_EDIT_TEXT_CHARS)}"`;
  return `${displayPath(uri, root)} ${formatRange(rangeFromLsp(record.range))} -> ${rendered}`;
}

/** One documentChanges entry (text edits or a create/rename/delete file op) as preview lines. */
function documentChangeLines(raw: unknown, root: string): string[] {
  const record = asRecord(raw);
  if (!record) {
    return [];
  }
  if (typeof record.kind === "string") {
    // A resource operation - serialized, labeled, and never performed.
    const at = (key: string): string =>
      typeof record[key] === "string" ? displayPath(record[key] as string, root) : "?";
    if (record.kind === "create") {
      return [`create ${at("uri")} [file operation - not applied]`];
    }
    if (record.kind === "rename") {
      return [`rename ${at("oldUri")} -> ${at("newUri")} [file operation - not applied]`];
    }
    if (record.kind === "delete") {
      return [`delete ${at("uri")} [file operation - not applied]`];
    }
    return [`${record.kind} [unrecognized file operation - not applied]`];
  }
  const textDocument = asRecord(record.textDocument);
  const uri = typeof textDocument?.uri === "string" ? textDocument.uri : "";
  const edits = Array.isArray(record.edits) ? record.edits : [];
  return edits.map((edit) => editLine(uri, edit, root));
}

/** A WorkspaceEdit (changes and/or documentChanges) as bounded reviewable preview text. */
function editPreview(raw: unknown, root: string): string | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const lines: string[] = [];
  const changes = asRecord(record.changes);
  if (changes) {
    for (const [uri, edits] of Object.entries(changes)) {
      if (Array.isArray(edits)) {
        lines.push(...edits.map((edit) => editLine(uri, edit, root)));
      }
    }
  }
  if (Array.isArray(record.documentChanges)) {
    for (const change of record.documentChanges) {
      lines.push(...documentChangeLines(change, root));
    }
  }
  if (lines.length === 0) {
    return undefined;
  }
  return capText(lines.join("\n"), MAX_LSP_PROPOSAL_TEXT_CHARS).text;
}

/** One decoded proposal, rendered; `index` is 1-based for the numbered list. */
function proposalBlock(raw: unknown, index: number, root: string): string[] {
  const record = asRecord(raw) ?? {};
  const title = typeof record.title === "string" ? record.title : "(untitled action)";
  const kind = typeof record.kind === "string" ? ` [${record.kind}]` : "";
  const preferred = record.isPreferred === true ? " (preferred)" : "";
  const lines = [`${index}. ${clipLine(title, MAX_EDIT_TEXT_CHARS)}${kind}${preferred}`];

  const preview = editPreview(record.edit, root);
  if (preview !== undefined) {
    lines.push(...preview.split("\n").map((line) => `   ${line}`));
    return lines;
  }
  if (record.command !== undefined) {
    // A Command literal or a CodeAction carrying only a command: running it would mutate
    // through the server, which the read-only first cut never does (D-005).
    lines.push("   command-only action - not executed (unsupported: mutating commands never run)");
    return lines;
  }
  lines.push("   no edit attached - proposal metadata only (nothing applied)");
  return lines;
}

/** Builds the lsp_code_actions tool over a manager; tools/index.ts binds the host singleton. */
export function buildLspCodeActionsTool(manager: LspManager): Tool<LspCodeActionsArgs> {
  return simpleTool({
    name: "lsp_code_actions",
    description:
      "List the language server's code-action PROPOSALS for a 1-based line range in a file - " +
      "title, kind, and a serialized edit preview. Strictly read-only: nothing is ever applied.",
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
      openWorkspaceFile(acquired.client, loaded);
      const outcome = await manager.request("textDocument/codeAction", {
        textDocument: { uri: loaded.uri },
        range: {
          start: toLspPosition(args.startLine, args.startColumn ?? 1),
          end: toLspPosition(args.endLine, args.endColumn ?? 1),
        },
        context: { diagnostics: [] },
      });
      if (outcome.kind === "degraded") {
        return describeDegraded(outcome);
      }
      const actions = Array.isArray(outcome.value)
        ? outcome.value.filter((entry) => asRecord(entry) !== undefined)
        : [];
      const where = `${loaded.display}:${args.startLine}-${args.endLine}`;
      if (actions.length === 0) {
        return `no code actions available at ${where}`;
      }
      const capped = capItems(actions, MAX_LSP_CODE_ACTIONS);
      const cut = capped.truncated ? `, showing the first ${MAX_LSP_CODE_ACTIONS}` : "";
      const header = `${actions.length} code action proposal(s) at ${where}${cut} (proposals only - nothing is applied):`;
      const blocks = capped.items.flatMap((action, index) =>
        proposalBlock(action, index + 1, root),
      );
      return [header, ...blocks].join("\n");
    },
  });
}
