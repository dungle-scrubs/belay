import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LspClient } from "@host/lsp/client";
import { displayPath } from "@host/lsp/format";
import type { LspManager } from "@host/lsp/manager";

/**
 * Shared file plumbing for the lsp_* tools (plan 24 M3-M5): resolving a tool's `file` argument
 * against the workspace root, language-id detection, uri conversion, syncing the file's CURRENT
 * disk content onto an acquired client (didOpen, or a full didChange re-sync when already open,
 * which is what keeps a stale server view fresh), and 1-based -> 0-based wire position encoding.
 * A missing/unreadable file is data (null) the tool renders as bounded text, never a throw.
 *
 * Responsible for: the workspace-file seam the lsp tool defs share.
 * Not for: display formatting (@host/lsp/format), lifecycle (@host/lsp/manager), or per-tool
 * params and rendering (./lsp-*).
 */

/** A tool's `file` argument, resolved and loaded from disk. */
export interface WorkspaceFile {
  readonly absolute: string;
  /** The workspace-relative display path result headers use. */
  readonly display: string;
  readonly uri: string;
  readonly text: string;
  readonly languageId: string;
}

const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".json": "json",
};

/** The LSP languageId for a path; unknown extensions sync as plaintext. */
export function languageIdFor(path: string): string {
  return LANGUAGE_IDS[extname(path).toLowerCase()] ?? "plaintext";
}

/** The workspace root the lsp tools resolve `file` against: the manager's default root. */
export function lspWorkspaceRoot(manager: LspManager): string {
  return manager.status().workspaceRoot;
}

/** Loads a `file` argument (workspace-relative or absolute); null when it cannot be read. */
export async function loadWorkspaceFile(root: string, file: string): Promise<WorkspaceFile | null> {
  const absolute = isAbsolute(file) ? file : resolve(root, file);
  try {
    const text = await readFile(absolute, "utf8");
    return {
      absolute,
      display: displayPath(absolute, root),
      uri: pathToFileURL(absolute).href,
      text,
      languageId: languageIdFor(absolute),
    };
  } catch {
    return null;
  }
}

/** The bounded not-found SUCCESS text every file-taking lsp tool shares (D-006). */
export function fileNotFound(file: string, root: string): string {
  return `file not found: ${file} (looked under ${root})`;
}

/** Syncs the loaded file onto the acquired client so the server analyzes its current content. */
export function openWorkspaceFile(client: LspClient, file: WorkspaceFile): void {
  client.openDocument(file.uri, file.languageId, file.text);
}

/** A tool's 1-based line/column encoded as the 0-based LSP wire position. */
export function toLspPosition(
  line: number,
  column: number,
): { readonly line: number; readonly character: number } {
  return {
    line: Math.max(0, Math.trunc(line) - 1),
    character: Math.max(0, Math.trunc(column) - 1),
  };
}
