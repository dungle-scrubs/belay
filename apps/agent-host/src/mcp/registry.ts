import type { McpServerConfig } from "./config";

/**
 * The named MCP server registry (plan 23 M1): the one lookup surface over the normalized
 * config. Every server - tool-proxy included (D-001) - resolves through the same exact-name
 * path; there is no privileged entry and no transport-specific lookup.
 *
 * Responsible for: listing configured servers, filtering to enabled ones, and resolving a
 * server by name.
 * Not for: parsing/validating config (./config) or opening connections (./stdio-transport).
 */

export interface McpRegistry {
  /** Every configured server, in config order (disabled included, for /doctor visibility). */
  readonly list: () => readonly McpServerConfig[];
  /** Only the servers eligible for connection. */
  readonly enabled: () => readonly McpServerConfig[];
  /** Exact-name lookup; `undefined` for unknown names (callers decide how to fail). */
  readonly get: (name: string) => McpServerConfig | undefined;
}

/** Builds the registry over an already-normalized server list (names are unique by then). */
export function createMcpRegistry(servers: readonly McpServerConfig[]): McpRegistry {
  const byName = new Map(servers.map((server) => [server.name, server]));
  const enabled = servers.filter((server) => server.enabled);
  return {
    list: () => servers,
    enabled: () => enabled,
    get: (name) => byName.get(name),
  };
}
