import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LspClient } from "@host/lsp/client";
import {
  degraded,
  type LspDegraded,
  type LspDiagnostic,
  type LspSeverity,
} from "@host/lsp/contract";
import { describeDegraded, displayPath } from "@host/lsp/format";
import type { LspManager } from "@host/lsp/manager";

/**
 * Shared file plumbing for the lsp_* tools (plan 24 M3-M5): resolving a tool's `file` argument
 * against the workspace root, language-id detection, uri conversion, syncing the file's CURRENT
 * disk content onto an acquired client (didOpen, or a full didChange re-sync when already open,
 * which is what keeps a stale server view fresh), the capability gate every request-shaped tool
 * runs before asking (a server that never advertised the provider degrades as "unsupported"
 * instead of being asked), and 1-based -> 0-based wire position encoding. A missing/unreadable
 * file is data (null) the tool renders as bounded text, never a throw.
 *
 * Responsible for: the workspace-file and capability-gate seams the lsp tool defs share.
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

/** The initialize-declared provider capabilities the request-shaped lsp tools gate on. */
export type LspProviderCapability =
  | "hoverProvider"
  | "documentSymbolProvider"
  | "workspaceSymbolProvider"
  | "codeActionProvider";

/**
 * The capability gate (D-006 "unsupported"): a degraded outcome when the acquired server's
 * initialize capabilities never advertised the provider - asking it would only earn a
 * method-not-found - or undefined when the request may proceed. LSP capability values are
 * `true` or an options object, so any truthy value counts as advertised.
 */
export function unsupportedCapability(
  acquired: { readonly client: LspClient; readonly server: string },
  provider: LspProviderCapability,
): LspDegraded | undefined {
  const capabilities = acquired.client.capabilities();
  if (capabilities === undefined || capabilities[provider]) {
    return undefined;
  }

  return degraded(
    "unsupported",
    `${acquired.server} does not advertise ${provider} in its initialize capabilities`,
  );
}

export interface FileLspRequestContext {
  readonly root: string;
  readonly loaded: WorkspaceFile;
  readonly acquired: { readonly client: LspClient; readonly server: string };
}

export interface FileLspRequestOptions<TPrepared = void> {
  readonly file: string;
  readonly capability: LspProviderCapability;
  readonly method: string;
  readonly prepare?: (context: FileLspRequestContext) => Promise<TPrepared> | TPrepared;
  readonly params: (context: FileLspRequestContext, prepared: TPrepared) => unknown;
  readonly render: (
    value: unknown,
    context: FileLspRequestContext,
    prepared: TPrepared,
  ) => string | Promise<string>;
}

/**
 * Runs the shared file-taking LSP tool pipeline: load file, acquire server, gate capability, sync
 * current file content, optionally prepare request context, issue request, render degradation or value.
 */
export async function runFileLspRequest<TPrepared = void>(
  manager: LspManager,
  options: FileLspRequestOptions<TPrepared>,
): Promise<string> {
  const root = lspWorkspaceRoot(manager);
  const loaded = await loadWorkspaceFile(root, options.file);
  if (!loaded) {
    return fileNotFound(options.file, root);
  }
  const acquired = await manager.acquire();
  if (acquired.kind === "degraded") {
    return describeDegraded(acquired);
  }
  const unsupported = unsupportedCapability(acquired, options.capability);
  if (unsupported) {
    return describeDegraded(unsupported);
  }

  openWorkspaceFile(acquired.client, loaded);
  const context = { root, loaded, acquired };
  const prepared =
    options.prepare === undefined ? (undefined as TPrepared) : await options.prepare(context);
  const outcome = await manager.request(options.method, options.params(context, prepared));
  if (outcome.kind === "degraded") {
    return describeDegraded(outcome);
  }
  return options.render(outcome.value, context, prepared);
}

export interface WorkspaceLspRequestContext {
  readonly root: string;
  readonly acquired: { readonly client: LspClient; readonly server: string };
}

export interface WorkspaceLspRequestOptions {
  readonly capability: LspProviderCapability;
  readonly method: string;
  readonly params: unknown;
  readonly render: (
    value: unknown,
    context: WorkspaceLspRequestContext,
  ) => string | Promise<string>;
}

/** Runs the shared workspace-scoped LSP request pipeline for tools that do not open a file first. */
export async function runWorkspaceLspRequest(
  manager: LspManager,
  options: WorkspaceLspRequestOptions,
): Promise<string> {
  const acquired = await manager.acquire();
  if (acquired.kind === "degraded") {
    return describeDegraded(acquired);
  }
  const unsupported = unsupportedCapability(acquired, options.capability);
  if (unsupported) {
    return describeDegraded(unsupported);
  }
  const outcome = await manager.request(options.method, options.params);
  if (outcome.kind === "degraded") {
    return describeDegraded(outcome);
  }
  return options.render(outcome.value, { root: lspWorkspaceRoot(manager), acquired });
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

const WIRE_SEVERITY: Readonly<Record<LspSeverity, number>> = {
  error: 1,
  warning: 2,
  info: 3,
  hint: 4,
};

/**
 * A stored contract diagnostic re-encoded to the 0-based LSP wire shape, for requests that
 * carry diagnostics back to the server (CodeActionContext). Real servers derive quickfixes
 * from exactly these - tsserver reads the numeric `code` - so the decode at the publish
 * boundary must round-trip: 1-based positions back to 0-based, named severity back to its
 * number, and an integer-looking code back to a number.
 */
export function toLspDiagnostic(diagnostic: LspDiagnostic): Record<string, unknown> {
  const code = Number(diagnostic.code);
  return {
    range: {
      start: toLspPosition(diagnostic.range.start.line, diagnostic.range.start.column),
      end: toLspPosition(diagnostic.range.end.line, diagnostic.range.end.column),
    },
    severity: WIRE_SEVERITY[diagnostic.severity],
    message: diagnostic.message,
    ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
    ...(diagnostic.code !== undefined
      ? { code: Number.isInteger(code) ? code : diagnostic.code }
      : {}),
  };
}
