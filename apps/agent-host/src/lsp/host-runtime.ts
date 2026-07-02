import { envPositiveMs } from "@host/boot/env";
import { createLspManager, type LspManager, type LspManagerOptions } from "./manager";

/**
 * The host-wide LSP manager singleton (plan 24 M3), in the mcp/host-runtime tradition: one lazy
 * per-workspace-root runtime manager shared by the model-facing lsp_* tools (tools/index.ts
 * binds it) and main.ts shutdown. Construction spawns NOTHING - a language server starts only
 * when a tool first acquires it (D-001) - so a workspace that never touches LSP costs no
 * process, socket, or file handle. Stdio language servers exit on parent death regardless of an
 * explicit close (their stdin pipe closes), so a hard exit cannot orphan them.
 *
 * Timeouts, the publish-wait deadline, and the stale threshold are env-tunable (plan 24 M7,
 * D-006): the host reads pure env, so `TREVOR_LSP_REQUEST_TIMEOUT_MS`,
 * `TREVOR_LSP_INIT_TIMEOUT_MS`, `TREVOR_LSP_PUBLISH_WAIT_MS`, and `TREVOR_LSP_STALE_AFTER_MS`
 * override the manager defaults per machine (a slow language server, a hermetic test bounding
 * its wall time). Absent or malformed values contribute nothing (boot/env's envPositiveMs).
 *
 * Responsible for: constructing and exporting the one host LSP manager, and the env -> options
 * mapping that configures it.
 * Not for: lifecycle mechanics (./manager), adapter selection (./adapter), the env-number
 * idiom (@host/boot/env), or the model-facing tool surfaces (@host/tools/lsp-*).
 */

/** The manager options the TREVOR_LSP_* env knobs contribute; {} leaves every default in place. */
export function lspManagerEnvOptions(env: NodeJS.ProcessEnv): LspManagerOptions {
  const requestTimeoutMs = envPositiveMs(env, "TREVOR_LSP_REQUEST_TIMEOUT_MS");
  const initTimeoutMs = envPositiveMs(env, "TREVOR_LSP_INIT_TIMEOUT_MS");
  const publishWaitMs = envPositiveMs(env, "TREVOR_LSP_PUBLISH_WAIT_MS");
  const staleAfterMs = envPositiveMs(env, "TREVOR_LSP_STALE_AFTER_MS");
  return {
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(initTimeoutMs !== undefined ? { initTimeoutMs } : {}),
    ...(publishWaitMs !== undefined ? { publishWaitMs } : {}),
    ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
  };
}

/** The one host LSP manager; lazy, so importing this spawns nothing. */
export const lspManager: LspManager = createLspManager(lspManagerEnvOptions(process.env));
