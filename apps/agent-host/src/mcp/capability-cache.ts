import {
  discoverCapabilities,
  type McpCapabilityRecord,
  type McpServerCapabilities,
} from "./capabilities";
import type { McpServerConfig } from "./config";
import type { McpTransport } from "./transport";

/**
 * The per-server MCP capability cache (plan 23 M4): holds the latest ./capabilities discovery
 * per named server with freshness metadata, re-discovers on demand (refreshCapabilities), and
 * exposes the catalog ONLY through capped, ranked substring search (searchCapabilities) -
 * D-003: a large catalog never dumps wholesale into a prompt; the search result is the only
 * exposure. snapshot() is the /doctor projection (D-009): plain serializable freshness/count
 * data, readable without touching any transport.
 *
 * Responsible for: caching discovery results, on-demand refresh, capped ranked search, and
 * the plain-data freshness snapshot.
 * Not for: talking to servers (./capabilities + the transports) or rendering status (doctor).
 */

/** How many hits a search returns when the caller does not ask for a limit. */
export const DEFAULT_MCP_SEARCH_LIMIT = 20;

/** The hard cap: no search result ever exceeds this, whatever limit the caller requests. */
export const MAX_MCP_SEARCH_RESULTS = 50;

/** One connected server the cache can discover from: its config plus its live transport. */
export interface McpCapabilitySource {
  readonly config: McpServerConfig;
  readonly transport: McpTransport;
}

export interface McpCapabilityCounts {
  readonly tools: number;
  readonly resources: number;
  readonly prompts: number;
}

/** One server's freshness line in the /doctor projection: data only, no handles. */
export interface McpCapabilityCacheSnapshotEntry {
  readonly server: string;
  readonly discovered: boolean;
  readonly discoveredAt?: number;
  readonly counts: McpCapabilityCounts;
  readonly lastError?: string;
}

export interface McpCapabilityCache {
  /** Re-discovers one server's capabilities; `undefined` for a name the cache does not know. */
  readonly refreshCapabilities: (serverName: string) => Promise<McpServerCapabilities | undefined>;
  /** The latest cached discovery for one server; `undefined` when unknown or never discovered.
   *  A read of the CACHE only - it never talks to the server (the runtime refreshes first when
   *  it needs freshness). */
  readonly capabilitiesFor: (serverName: string) => McpServerCapabilities | undefined;
  /** Capped, ranked substring search over cached names + descriptions (D-003). */
  readonly searchCapabilities: (
    query: string,
    options?: { readonly limit?: number },
  ) => readonly McpCapabilityRecord[];
  /** The plain-data freshness projection for /doctor (D-009). */
  readonly snapshot: () => readonly McpCapabilityCacheSnapshotEntry[];
}

interface CacheEntry {
  readonly source: McpCapabilitySource;
  capabilities?: McpServerCapabilities;
  discoveredAt?: number;
  lastError?: string;
}

export interface CapabilityCacheOptions {
  /** The clock behind discoveredAt (default `Date.now`); injectable for tests. */
  readonly now?: () => number;
}

/** Builds the cache over connected sources; nothing is discovered until the first refresh. */
export function createMcpCapabilityCache(
  sources: readonly McpCapabilitySource[],
  options: CapabilityCacheOptions = {},
): McpCapabilityCache {
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>(
    sources.map((source) => [source.config.name, { source }]),
  );

  const refreshCapabilities = async (
    serverName: string,
  ): Promise<McpServerCapabilities | undefined> => {
    const entry = entries.get(serverName);
    if (!entry) {
      return undefined;
    }
    try {
      const capabilities = await discoverCapabilities(entry.source.config, entry.source.transport);
      entry.capabilities = capabilities;
      entry.discoveredAt = now();
      entry.lastError = undefined;
      return capabilities;
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const capabilitiesFor = (serverName: string): McpServerCapabilities | undefined =>
    entries.get(serverName)?.capabilities;

  const searchCapabilities = (
    query: string,
    searchOptions: { readonly limit?: number } = {},
  ): readonly McpCapabilityRecord[] => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return []; // D-003: an empty query is a catalog dump in disguise
    }
    const limit = Math.min(
      Math.max(1, Math.floor(searchOptions.limit ?? DEFAULT_MCP_SEARCH_LIMIT)),
      MAX_MCP_SEARCH_RESULTS,
    );

    const scored: { record: McpCapabilityRecord; score: number }[] = [];
    for (const entry of entries.values()) {
      for (const record of allRecords(entry.capabilities)) {
        const score = scoreMatch(record, needle);
        if (score !== undefined) {
          scored.push({ record, score });
        }
      }
    }
    scored.sort(
      (a, b) => a.score - b.score || a.record.qualifiedName.localeCompare(b.record.qualifiedName),
    );
    return scored.slice(0, limit).map((hit) => hit.record);
  };

  const snapshot = (): readonly McpCapabilityCacheSnapshotEntry[] =>
    [...entries.values()].map((entry) => ({
      server: entry.source.config.name,
      discovered: entry.capabilities !== undefined,
      ...(entry.discoveredAt !== undefined ? { discoveredAt: entry.discoveredAt } : {}),
      counts: {
        tools: entry.capabilities?.tools.length ?? 0,
        resources: entry.capabilities?.resources.length ?? 0,
        prompts: entry.capabilities?.prompts.length ?? 0,
      },
      ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
    }));

  return { refreshCapabilities, capabilitiesFor, searchCapabilities, snapshot };
}

function allRecords(capabilities: McpServerCapabilities | undefined): McpCapabilityRecord[] {
  if (!capabilities) {
    return [];
  }
  return [...capabilities.tools, ...capabilities.resources, ...capabilities.prompts];
}

/** Lower is better: exact name, name prefix, name substring, qualified name, description. */
function scoreMatch(record: McpCapabilityRecord, needle: string): number | undefined {
  const name = record.name.toLowerCase();
  if (name === needle) {
    return 0;
  }
  if (name.startsWith(needle)) {
    return 1;
  }
  if (name.includes(needle)) {
    return 2;
  }
  if (record.qualifiedName.toLowerCase().includes(needle)) {
    return 3;
  }
  if (record.description?.toLowerCase().includes(needle)) {
    return 4;
  }
  return undefined;
}
