import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Fixture-workspace builder for the plan 24 M7 eval and distraction turns: a real temp TS
 * workspace the host singleton (WORKSPACE_ROOT via TREVOR_WORKSPACE) treats as production
 * would. `tsconfig.json` makes the TS/JS adapter detect it, and - when `server` is true - a
 * `node_modules/.bin/typescript-language-server` shim resolves through the adapter's REAL
 * workspace-local binary lookup and launches ./fixture-eval-lsp-server.ts, so the whole
 * production path (adapter detection -> binary resolution -> spawn -> initialize -> tools)
 * is exercised hermetically. Without the shim (and with PATH cleared by the test), the same
 * path degrades to the "not installed" outcome.
 *
 * Responsible for: laying the fixture workspace on disk.
 * Not for: server behavior (./fixture-eval-lsp-server) or env wiring - the test files own
 * TREVOR_WORKSPACE and the TREVOR_LSP_* knobs, which bind BEFORE any host module loads.
 */

const EVAL_SERVER_PATH = join(import.meta.dirname, "fixture-eval-lsp-server.ts");

export interface EvalWorkspaceOptions {
  /** Workspace-relative file path -> content. */
  readonly files: Readonly<Record<string, string>>;
  /** Install the eval fixture server as the workspace-local language-server binary. */
  readonly server: boolean;
}

/** Builds the fixture workspace and returns its absolute root. Caller removes it in afterAll. */
export function createEvalWorkspace(options: EvalWorkspaceOptions): string {
  const root = mkdtempSync(join(tmpdir(), "trevor-lsp-eval-"));
  writeFileSync(join(root, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }\n');
  for (const [path, content] of Object.entries(options.files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  if (options.server) {
    const shim = join(root, "node_modules", ".bin", "typescript-language-server");
    mkdirSync(dirname(shim), { recursive: true });
    // The child inherits the vitest worker's cwd (the repo root), so the bare `tsx` specifier
    // resolves exactly as ./fixture-config.ts's launch recipe does for the protocol fixture.
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" --import tsx "${EVAL_SERVER_PATH}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }
  return root;
}
