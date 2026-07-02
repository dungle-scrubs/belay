import { join } from "node:path";
import type { McpHttpServerConfig, McpStdioServerConfig } from "@host/mcp/config";

/**
 * Shared fixture-SERVER config builders (plan 23 M9): the one place that knows how to launch
 * the stdio fixture (./fixture-server.ts under the repo's tsx runner) and how a fixture server
 * appears as a normalized McpServerConfig. Both the host integration tests (test/mcp/*.test.ts)
 * and the cross-service e2e suite (via the `@trevor/agent-host/testing/mcp-fixtures` export)
 * build their server entries here, so the launch recipe is never re-spelled.
 *
 * Responsible for: the stdio fixture launch recipe and the stdio/http fixture config builders.
 * Not for: fixture behavior (./fixture-server, ./fixture-http-server) or the served catalog
 * (./fixture-catalog).
 */

/** The stdio fixture server script both the integration and e2e suites spawn. */
export const STDIO_FIXTURE_PATH = join(import.meta.dirname, "fixture-server.ts");

/** The command that runs the fixture: this test process's own node binary. */
export const STDIO_FIXTURE_COMMAND = process.execPath;

/** The argv that loads the TypeScript fixture through tsx, plus any fixture flags
 *  (`--catalog=large`, `--protocol=...`). */
export function stdioFixtureArgs(flags: readonly string[] = []): string[] {
  return ["--import", "tsx", STDIO_FIXTURE_PATH, ...flags];
}

/** A normalized stdio config over the fixture server; overrides layer on top. */
export function stdioFixtureConfig(
  name: string,
  overrides: Partial<McpStdioServerConfig> = {},
): McpStdioServerConfig {
  return {
    name,
    enabled: true,
    transport: "stdio",
    command: STDIO_FIXTURE_COMMAND,
    args: stdioFixtureArgs(),
    env: {},
    exposure: { tools: true, resources: true, prompts: true },
    requestTimeoutMs: 10_000,
    ...overrides,
  } as McpStdioServerConfig;
}

/** A normalized http config over a started ./fixture-http-server endpoint. */
export function httpFixtureConfig(
  name: string,
  endpoint: string,
  overrides: Partial<McpHttpServerConfig> = {},
): McpHttpServerConfig {
  return {
    name,
    enabled: true,
    transport: "http",
    endpoint,
    exposure: { tools: true, resources: true, prompts: true },
    requestTimeoutMs: 10_000,
    ...overrides,
  } as McpHttpServerConfig;
}
