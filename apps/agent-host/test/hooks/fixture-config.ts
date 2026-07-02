import { join } from "node:path";
import type { HookDefinition } from "@host/hooks/config";

/**
 * Shared fixture-hook launch recipe for the hooks integration tests (plan 25 M3): how to run
 * ./fixture-hook.ts under the repo's tsx runner (mirroring test/lsp/fixture-config.ts and
 * test/mcp/fixture-config.ts), packaged as a normalized HookDefinition so runner tests spawn
 * exactly what discovery would hand them.
 *
 * Responsible for: the fixture-hook launch recipe and the fixture HookDefinition builder.
 * Not for: fixture behavior - ./fixture-hook owns that.
 */

/** The hook fixture script the suites spawn. */
export const HOOK_FIXTURE_PATH = join(import.meta.dirname, "fixture-hook.ts");

/** The command that runs the fixture: this test process's own node binary. */
export const HOOK_FIXTURE_COMMAND = process.execPath;

/** The tsx loader as an absolute URL: hook children run with cwd pinned to a (temp) workspace
 *  root, where a bare `--import tsx` cannot resolve - the loader must not depend on the child's
 *  cwd, exactly like production hooks must not depend on the host's node_modules. */
const TSX_LOADER = import.meta.resolve("tsx");

/** The argv that loads the TypeScript fixture through tsx: a mode plus its flags. */
export function hookFixtureArgs(mode: string, flags: readonly string[] = []): string[] {
  return ["--import", TSX_LOADER, HOOK_FIXTURE_PATH, mode, ...flags];
}

/** A normalized project-scope HookDefinition over the fixture; overrides layer on top. */
export function fixtureHook(
  mode: string,
  flags: readonly string[] = [],
  overrides: Partial<HookDefinition> = {},
): HookDefinition {
  return {
    id: "fixture",
    event: "PreToolUse",
    command: HOOK_FIXTURE_COMMAND,
    args: hookFixtureArgs(mode, flags),
    timeoutMs: 5_000,
    enabled: true,
    source: "project",
    ...overrides,
  };
}
