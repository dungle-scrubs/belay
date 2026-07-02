import { type ToolError, ToolExecutionError, ToolInputError } from "@host/tools/errors";
import { cap } from "@host/tools/shared";
import { msg } from "@host/transport/messages";
import { Effect } from "effect";
import type { McpResourceRecord } from "./capabilities";
import type { McpCapabilityCounts } from "./capability-cache";
import { createMcpCapabilityCache, type McpCapabilityCache } from "./capability-cache";
import { type McpExposure, type McpServerConfig, redactMcpEndpoint } from "./config";
import { boundText, decodeResourceContents, decodeToolCallResult } from "./content";
import { isMcpTransportError, McpClosedError } from "./errors";
import { createHttpTransport } from "./http-transport";
import { createMcpRegistry } from "./registry";
import { spawnStdioTransport } from "./stdio-transport";
import type { McpTransport, McpTransportState, McpTransportStatus } from "./transport";

/**
 * The host-lifetime MCP runtime (plan 23 M5): the ONE seam wiring the named-server registry to
 * transports and the capability cache. Constructed once at host startup; everything above it
 * (the model-facing surface, /doctor, debug) programs against this object and never touches a
 * transport directly (D-007). Connections are LAZY: a server's transport is constructed on the
 * first operation that needs it, so configuring ten servers costs nothing until one is used.
 *
 * Execution semantics (D-008): `callTool` speaks the host tool contract exactly -
 * `Effect<string, ToolError>` (tools/types.ts) - so the model-facing MCP tool (M7) rides
 * Trevor's normal tool boundary: tool.started/tool.completed events, redaction, truncation
 * (tools/shared.ts norms), and cancellation (the Effect interrupts like any other tool;
 * the abandoned request settles server-side and its late reply is dropped by the transport).
 * Scheduling classification: an external MCP tool mutates EXTERNAL service state - a different
 * risk axis than workspace mutation (`Tool.readOnly`) - and there is no explicit read-only
 * classification for external tools, so an MCP call is ALWAYS a mutating serial barrier:
 * qualified names never join READ_ONLY_TOOL_NAMES, and whatever tool def wraps `callTool`
 * must leave `readOnly` unset.
 *
 * Resources are attributable CONTEXT records, not tool execution: list/read return
 * provenance-carrying records (server + uri + mime) with bounded content, for the M7 surface
 * to expose.
 *
 * Responsible for: the runtime seam - lazy per-server connections, qualified-identity call
 * execution, resource list/read records, the capability cache wiring, the /doctor status
 * snapshot, and shutdown.
 * Not for: wire mechanics (./stdio-transport, ./http-transport), discovery decoding
 * (./capabilities), caching/search policy (./capability-cache), or payload decoding
 * (./content).
 */

/** A resource read as an attributable context record: bounded content plus provenance. */
export interface McpResourceContext {
  readonly kind: "mcp_resource";
  readonly server: string;
  readonly uri: string;
  readonly mimeType?: string;
  readonly text: string;
  readonly truncated: boolean;
}

/** One server's line in the /doctor projection (D-009): plain data, secrets redacted. */
export interface McpServerStatusEntry {
  readonly server: string;
  readonly enabled: boolean;
  readonly transport: "stdio" | "http";
  readonly status: McpTransportStatus;
  /** The redacted connection target: the command word (stdio; args may carry secrets) or the
   *  endpoint origin + path (http; query/userinfo stripped). */
  readonly target: string;
  readonly exposure: McpExposure;
  readonly protocolVersion?: string;
  readonly lastError?: string;
  readonly capabilities: {
    readonly discovered: boolean;
    readonly discoveredAt?: number;
    readonly counts: McpCapabilityCounts;
  };
}

export interface McpRuntimeOptions {
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** The host env the stdio transports filter (default `process.env`); injectable for tests. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** The clock behind capability freshness (default `Date.now`); injectable for tests. */
  readonly now?: () => number;
}

export interface McpRuntime {
  /** Executes `<server>:<tool>` through the host tool contract: bounded text, typed ToolError. */
  readonly callTool: (
    qualifiedName: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<string, ToolError>;
  /** Discovered resource records: one server's (strict) or every enabled server's (tolerant -
   *  a failing server contributes nothing; its error lands in the status snapshot). */
  readonly listResources: (
    serverName?: string,
  ) => Effect.Effect<readonly McpResourceRecord[], ToolError>;
  /** Reads one resource into a bounded, provenance-carrying context record. */
  readonly readResource: (
    serverName: string,
    uri: string,
  ) => Effect.Effect<McpResourceContext, ToolError>;
  /** The capability cache (M4): refresh, cached records, capped search, freshness snapshot. */
  readonly capabilities: McpCapabilityCache;
  /** The per-server /doctor projection (D-009). */
  readonly statusSnapshot: () => readonly McpServerStatusEntry[];
  /** Closes every connected transport; idempotent. Later operations fail closed. */
  readonly close: () => Promise<void>;
}

interface Connection {
  readonly config: McpServerConfig;
  transport?: McpTransport;
}

/** Builds the runtime over an already-normalized server list (config.ts owns validation). */
export function createMcpRuntime(
  servers: readonly McpServerConfig[],
  options: McpRuntimeOptions = {},
): McpRuntime {
  const registry = createMcpRegistry(servers);
  const connections = new Map<string, Connection>(
    servers.map((config) => [config.name, { config }]),
  );
  let closed = false;
  let closePromise: Promise<void> | null = null;

  /** The lazy-connect point: every transport construction funnels through here (D-007). */
  const transportOf = (connection: Connection): McpTransport => {
    if (closed) {
      throw new McpClosedError({
        server: connection.config.name,
        detail: "the MCP runtime is closed",
      });
    }
    connection.transport ??=
      connection.config.transport === "stdio"
        ? spawnStdioTransport(connection.config, {
            ...(options.clientInfo ? { clientInfo: options.clientInfo } : {}),
            ...(options.hostEnv ? { hostEnv: options.hostEnv } : {}),
          })
        : createHttpTransport(connection.config, {
            ...(options.clientInfo ? { clientInfo: options.clientInfo } : {}),
          });
    return connection.transport;
  };

  const stateOf = (connection: Connection): McpTransportState =>
    connection.transport?.state() ?? {
      status: closed ? "closed" : "configured",
      initialized: false,
    };

  /** A cache source over the lazy connection: discovery connects on first use, nothing sooner. */
  const lazySource = (connection: Connection): McpTransport => ({
    initialize: async () => transportOf(connection).initialize(),
    request: async (method, params) => transportOf(connection).request(method, params),
    notify: (method, params) => connection.transport?.notify(method, params),
    close: async () => connection.transport?.close(),
    state: () => stateOf(connection),
  });

  const cache = createMcpCapabilityCache(
    servers
      .filter((config) => config.enabled)
      .map((config) => {
        const connection = connections.get(config.name);
        return { config, transport: lazySource(connection ?? { config }) };
      }),
    options.now ? { now: options.now } : {},
  );

  /** Resolves a bare server name for a capability family; a miss is a typed input error. */
  const resolveServer = (
    serverName: string,
    family: keyof McpExposure,
  ): Connection | ToolInputError => {
    const connection = connections.get(serverName);
    if (!connection) {
      return new ToolInputError({ tool: serverName, detail: `unknown MCP server "${serverName}"` });
    }
    if (!connection.config.enabled) {
      return new ToolInputError({
        tool: serverName,
        detail: `MCP server "${serverName}" is disabled`,
      });
    }
    if (!connection.config.exposure[family]) {
      return new ToolInputError({
        tool: serverName,
        detail: `MCP server "${serverName}" does not expose ${family}`,
      });
    }
    return connection;
  };

  /** Splits the D-005 qualified identity `<server>:<name>` and resolves the server half. */
  const resolveQualified = (
    qualifiedName: string,
    family: keyof McpExposure,
  ): { readonly connection: Connection; readonly name: string } | ToolInputError => {
    const colon = qualifiedName.indexOf(":");
    if (colon <= 0 || colon === qualifiedName.length - 1) {
      return new ToolInputError({
        tool: qualifiedName,
        detail: `an MCP capability is addressed by its qualified name "<server>:<name>"; got "${qualifiedName}"`,
      });
    }
    const resolved = resolveServer(qualifiedName.slice(0, colon), family);
    if (resolved instanceof ToolInputError) {
      // Re-attribute the failure to the full qualified name the caller used.
      return new ToolInputError({ tool: qualifiedName, detail: resolved.detail });
    }
    return { connection: resolved, name: qualifiedName.slice(colon + 1) };
  };

  /** Classifies any rejection into the host ToolError vocabulary. Transport failures arrive
   *  pre-redacted (./errors carries redacted endpoints, never tokens), so their message is safe. */
  const classify = (tool: string, cause: unknown): ToolError =>
    new ToolExecutionError({
      tool,
      detail: isMcpTransportError(cause) ? cause.message : msg(cause),
      cause,
    });

  const callTool = (
    qualifiedName: string,
    args?: Record<string, unknown>,
  ): Effect.Effect<string, ToolError> =>
    Effect.suspend(() => {
      const resolved = resolveQualified(qualifiedName, "tools");
      if (resolved instanceof ToolInputError) {
        return Effect.fail<ToolError>(resolved);
      }
      return Effect.tryPromise({
        try: async () => {
          const transport = transportOf(resolved.connection);
          await transport.initialize();
          return transport.request("tools/call", { name: resolved.name, arguments: args ?? {} });
        },
        catch: (cause) => classify(qualifiedName, cause),
      }).pipe(
        Effect.flatMap((raw) => {
          const outcome = decodeToolCallResult(raw);
          const text = cap(outcome.text);
          if (outcome.isError) {
            return Effect.fail(
              new ToolExecutionError({
                tool: qualifiedName,
                detail: text.length > 0 ? text : "the MCP tool reported an error with no content",
              }),
            );
          }
          return Effect.succeed(text);
        }),
      );
    });

  /** Cached records for one server, discovering on first use (cache reads stay cache reads). */
  const discoveredResources = async (serverName: string): Promise<readonly McpResourceRecord[]> => {
    if (cache.capabilitiesFor(serverName) === undefined) {
      await cache.refreshCapabilities(serverName);
    }
    return cache.capabilitiesFor(serverName)?.resources ?? [];
  };

  const listResources = (
    serverName?: string,
  ): Effect.Effect<readonly McpResourceRecord[], ToolError> =>
    Effect.suspend(() => {
      if (serverName !== undefined) {
        const resolved = resolveServer(serverName, "resources");
        if (resolved instanceof ToolInputError) {
          return Effect.fail<ToolError>(resolved);
        }
        return Effect.tryPromise({
          try: () => discoveredResources(serverName),
          catch: (cause) => classify(serverName, cause),
        });
      }
      // The every-server listing is tolerant: one unreachable server must not hide the rest;
      // its failure is already recorded on the cache/transport for the status snapshot.
      return Effect.promise(async () => {
        const eligible = registry
          .enabled()
          .filter((config) => config.exposure.resources)
          .map((config) => config.name);
        const listed = await Promise.all(
          eligible.map((name) => discoveredResources(name).catch(() => [])),
        );
        return listed.flat();
      });
    });

  const readResource = (
    serverName: string,
    uri: string,
  ): Effect.Effect<McpResourceContext, ToolError> =>
    Effect.suspend(() => {
      const resolved = resolveServer(serverName, "resources");
      if (resolved instanceof ToolInputError) {
        return Effect.fail<ToolError>(resolved);
      }
      return Effect.tryPromise({
        try: async () => {
          const transport = transportOf(resolved);
          await transport.initialize();
          return transport.request("resources/read", { uri });
        },
        catch: (cause) => classify(serverName, cause),
      }).pipe(
        Effect.map((raw) => {
          const decoded = decodeResourceContents(raw);
          const bounded = boundText(decoded.text);
          return {
            kind: "mcp_resource" as const,
            server: serverName,
            uri,
            ...(decoded.mimeType !== undefined ? { mimeType: decoded.mimeType } : {}),
            text: bounded.text,
            truncated: bounded.truncated,
          };
        }),
      );
    });

  const statusSnapshot = (): readonly McpServerStatusEntry[] => {
    const discovery = new Map(cache.snapshot().map((entry) => [entry.server, entry]));
    return registry.list().map((config) => {
      const connection = connections.get(config.name);
      const state = connection ? stateOf(connection) : stateOf({ config });
      const discovered = discovery.get(config.name);
      return {
        server: config.name,
        enabled: config.enabled,
        transport: config.transport,
        status: state.status,
        target: config.transport === "stdio" ? config.command : redactMcpEndpoint(config.endpoint),
        exposure: config.exposure,
        ...(state.protocolVersion ? { protocolVersion: state.protocolVersion } : {}),
        ...(state.lastError ? { lastError: state.lastError } : {}),
        capabilities: {
          discovered: discovered?.discovered ?? false,
          ...(discovered?.discoveredAt !== undefined
            ? { discoveredAt: discovered.discoveredAt }
            : {}),
          counts: discovered?.counts ?? { tools: 0, resources: 0, prompts: 0 },
        },
      };
    });
  };

  const doClose = async (): Promise<void> => {
    closed = true;
    await Promise.all([...connections.values()].map((connection) => connection.transport?.close()));
  };

  return {
    callTool,
    listResources,
    readResource,
    capabilities: cache,
    statusSnapshot,
    close: () => {
      closePromise ??= doClose();
      return closePromise;
    },
  };
}
