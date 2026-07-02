import { join } from "node:path";
import type { LanguageServerAdapter, LspSpawnSpec } from "@host/lsp/adapter";

/**
 * Shared fixture-SERVER launch recipes for the LSP integration tests (plan 24 M2): how to run
 * ./fixture-lsp-server.ts under the repo's tsx runner (mirroring test/mcp/fixture-config.ts),
 * both as a raw spawn spec for client-level tests and as a LanguageServerAdapter for
 * manager-level tests.
 *
 * Responsible for: the stdio LSP fixture launch recipe and the fixture adapter builder.
 * Not for: fixture behavior - ./fixture-lsp-server owns that.
 */

/** The stdio LSP fixture server script the suites spawn. */
export const LSP_FIXTURE_PATH = join(import.meta.dirname, "fixture-lsp-server.ts");

/** The command that runs the fixture: this test process's own node binary. */
export const LSP_FIXTURE_COMMAND = process.execPath;

/** The argv that loads the TypeScript fixture through tsx, plus any fixture flags. */
export function lspFixtureArgs(flags: readonly string[] = []): string[] {
  return ["--import", "tsx", LSP_FIXTURE_PATH, ...flags];
}

/** A raw spawn spec over the fixture (client-level tests). */
export function lspFixtureSpawnSpec(flags: readonly string[] = []): LspSpawnSpec {
  return { command: LSP_FIXTURE_COMMAND, args: lspFixtureArgs(flags) };
}

/** The fixture as an always-matching adapter (manager-level tests). */
export function lspFixtureAdapter(flags: readonly string[] = []): LanguageServerAdapter {
  return {
    id: "fixture",
    displayName: "trevor-lsp-fixture",
    detects: () => true,
    resolveCommand: () => lspFixtureSpawnSpec(flags),
  };
}
