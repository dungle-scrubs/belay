import { createLspManager, type LspManager } from "./manager";

/**
 * The host-wide LSP manager singleton (plan 24 M3), in the mcp/host-runtime tradition: one lazy
 * per-workspace-root runtime manager shared by the model-facing lsp_* tools (tools/index.ts
 * binds it) and main.ts shutdown. Construction spawns NOTHING - a language server starts only
 * when a tool first acquires it (D-001) - so a workspace that never touches LSP costs no
 * process, socket, or file handle. Stdio language servers exit on parent death regardless of an
 * explicit close (their stdin pipe closes), so a hard exit cannot orphan them.
 *
 * Responsible for: constructing and exporting the one host LSP manager.
 * Not for: lifecycle mechanics (./manager), adapter selection (./adapter), or the model-facing
 * tool surfaces (@host/tools/lsp-*).
 */

/** The one host LSP manager; lazy, so importing this spawns nothing. */
export const lspManager: LspManager = createLspManager();
