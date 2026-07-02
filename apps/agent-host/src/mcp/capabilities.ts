import type { McpServerConfig } from "./config";
import { isMcpTransportError } from "./errors";
import type { McpTransport } from "./transport";

/**
 * MCP capability discovery (plan 23 M4): asks a connected transport for its tools
 * (tools/list), resources (resources/list), and prompts (prompts/list), following list
 * pagination cursors, and normalizes every entry into a provenance-carrying record under the
 * qualified identity `<server>:<name>` (D-005) - duplicate simple names across servers are
 * normal and coexist. The per-server exposure flags (D-002) gate each family at the source: a
 * family switched off is never even requested. Decoding is tolerant in the ./config tradition
 * (a nameless entry is dropped, not thrown), and a server that answers a list method with a
 * JSON-RPC error (no such family) contributes an empty family; hard transport failures
 * propagate untouched.
 *
 * Responsible for: transport-driven discovery of tool/resource/prompt records with qualified
 * identity, server provenance, and exposure filtering.
 * Not for: caching, refresh, or search - ./capability-cache owns those.
 */

export interface McpToolRecord {
  readonly kind: "tool";
  readonly server: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpResourceRecord {
  readonly kind: "resource";
  readonly server: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly uri: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPromptRecord {
  readonly kind: "prompt";
  readonly server: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly description?: string;
  readonly arguments?: unknown;
}

export type McpCapabilityRecord = McpToolRecord | McpResourceRecord | McpPromptRecord;

export interface McpServerCapabilities {
  readonly server: string;
  readonly tools: readonly McpToolRecord[];
  readonly resources: readonly McpResourceRecord[];
  readonly prompts: readonly McpPromptRecord[];
}

/** The D-005 qualified identity: `<server>:<name>` (config bans `:` inside server names). */
export function qualifyCapabilityName(server: string, name: string): string {
  return `${server}:${name}`;
}

/**
 * Discovers every exposed capability family from a connected transport. Initialization is
 * memoized by the transport, so calling this on a fresh transport is safe.
 */
export async function discoverCapabilities(
  server: Pick<McpServerConfig, "name" | "exposure">,
  transport: McpTransport,
): Promise<McpServerCapabilities> {
  await transport.initialize();
  const [tools, resources, prompts] = await Promise.all([
    server.exposure.tools ? listAll(transport, "tools/list", "tools") : [],
    server.exposure.resources ? listAll(transport, "resources/list", "resources") : [],
    server.exposure.prompts ? listAll(transport, "prompts/list", "prompts") : [],
  ]);
  return {
    server: server.name,
    tools: decodeAll(tools, (raw) => decodeTool(server.name, raw)),
    resources: decodeAll(resources, (raw) => decodeResource(server.name, raw)),
    prompts: decodeAll(prompts, (raw) => decodePrompt(server.name, raw)),
  };
}

/** Follows nextCursor pages; a JSON-RPC error means "family unsupported" -> what we have so far. */
async function listAll(
  transport: McpTransport,
  method: string,
  key: "tools" | "resources" | "prompts",
): Promise<readonly unknown[]> {
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    let page: unknown;
    try {
      page = await transport.request(method, cursor === undefined ? undefined : { cursor });
    } catch (error) {
      if (isMcpTransportError(error) && error._tag === "McpRpcError") {
        return items;
      }
      throw error;
    }
    const record = asRecord(page);
    const list = record?.[key];
    if (Array.isArray(list)) {
      items.push(...list);
    }
    const next = record?.nextCursor;
    cursor =
      typeof next === "string" && next.length > 0 && !seenCursors.has(next) ? next : undefined;
    if (cursor !== undefined) {
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  return items;
}

function decodeAll<T>(
  raw: readonly unknown[],
  decode: (entry: unknown) => T | undefined,
): readonly T[] {
  return raw.map(decode).filter((record): record is T => record !== undefined);
}

function decodeTool(server: string, raw: unknown): McpToolRecord | undefined {
  const record = asRecord(raw);
  const name = asNonEmptyString(record?.name);
  if (!record || !name) {
    return undefined;
  }
  return {
    kind: "tool",
    server,
    name,
    qualifiedName: qualifyCapabilityName(server, name),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(record.inputSchema !== undefined ? { inputSchema: record.inputSchema } : {}),
  };
}

function decodeResource(server: string, raw: unknown): McpResourceRecord | undefined {
  const record = asRecord(raw);
  const name = asNonEmptyString(record?.name);
  const uri = asNonEmptyString(record?.uri);
  if (!record || !name || !uri) {
    return undefined;
  }
  return {
    kind: "resource",
    server,
    name,
    qualifiedName: qualifyCapabilityName(server, name),
    uri,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
  };
}

function decodePrompt(server: string, raw: unknown): McpPromptRecord | undefined {
  const record = asRecord(raw);
  const name = asNonEmptyString(record?.name);
  if (!record || !name) {
    return undefined;
  }
  return {
    kind: "prompt",
    server,
    name,
    qualifiedName: qualifyCapabilityName(server, name),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(record.arguments !== undefined ? { arguments: record.arguments } : {}),
  };
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}
