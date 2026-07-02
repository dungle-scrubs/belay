import { abbrevHome, USER_MCP_SERVERS_JSON } from "@host/boot/paths";
import type {
  McpCapabilityRecord,
  McpPromptRecord,
  McpResourceRecord,
} from "@host/mcp/capabilities";
import { DEFAULT_MCP_SEARCH_LIMIT, MAX_MCP_SEARCH_RESULTS } from "@host/mcp/capability-cache";
import type {
  McpPromptArtifact,
  McpResourceContext,
  McpRuntime,
  McpServerStatusEntry,
} from "@host/mcp/runtime";
import { Effect, Schema } from "effect";
import { type ToolError, ToolInputError } from "./errors";
import { cap, clamp } from "./shared";
import type { Tool } from "./types";

/**
 * The model-facing `mcp` tool (plan 23 M7): ONE action-dispatch surface (the docs-tool
 * precedent) over the host MCP runtime seam. MCP is presented GENERICALLY (D-001) - the tool
 * knows named servers, never any specific integration - and discovery is search-only (D-003):
 * there is no list-everything action, results are ranked and capped, and the description stays
 * bounded guidance rather than a catalog. Every capability is addressed by its qualified
 * `<server>:<name>` identity (D-005). The tool leaves `readOnly` unset: an external MCP call
 * mutates EXTERNAL service state, so it is always a mutating serial barrier (D-008). With no
 * servers configured every action degrades to one clean pointer at mcp-servers.json.
 *
 * Responsible for: the mcp tool definition - params, the action router, result rendering, and
 * the unconfigured degradation.
 * Not for: execution, identity resolution, or transports (@host/mcp/runtime), catalog search
 * policy (@host/mcp/capability-cache), or the singleton wiring (@host/mcp/host-runtime).
 */

const MCP_ACTIONS = ["search", "call", "resources", "prompt", "status"] as const;

/** How much of one capability's description survives into a search/list line. */
const LINE_DESCRIPTION_CHARS = 160;

/** Free-form MCP arguments; the explicit jsonSchema keeps the advertised schema a plain open
 *  object (the derived Record schema nests a `$id` some OpenAI-compatible providers reject). */
const ArgsRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({
  jsonSchema: { type: "object", additionalProperties: true },
});

export const McpParams = Schema.Struct({
  action: Schema.Literal(...MCP_ACTIONS).annotations({
    description:
      "What to do: 'search' (find capabilities across servers by keyword), 'call' (run one " +
      "external tool), 'resources' (list attributable context records, or read one with " +
      "server+uri), 'prompt' (list prompts, or expand one with name), or 'status' (per-server " +
      "health).",
  }),
  query: Schema.optional(Schema.String).annotations({
    description: "search: the keyword to match against capability names and descriptions.",
  }),
  limit: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: 1, maximum: MAX_MCP_SEARCH_RESULTS },
    }),
  ).annotations({
    description: `search: max results, clamped to [1, ${MAX_MCP_SEARCH_RESULTS}] (default ${DEFAULT_MCP_SEARCH_LIMIT}).`,
  }),
  name: Schema.optional(Schema.String).annotations({
    description:
      "call/prompt: the QUALIFIED capability name '<server>:<name>', e.g. 'github:create_issue'.",
  }),
  args: Schema.optional(ArgsRecord).annotations({
    description: "call/prompt: the arguments object passed to the tool or prompt.",
  }),
  server: Schema.optional(Schema.String).annotations({
    description:
      "resources/prompt: restrict listing to one named server; required with uri to read a resource.",
  }),
  uri: Schema.optional(Schema.String).annotations({
    description: "resources: the resource uri to read (requires server).",
  }),
});

export type McpArgs = typeof McpParams.Type;

const MCP_DESCRIPTION =
  "Use the user's configured MCP servers - external integrations connected to Trevor, each a " +
  "named server exposing tools, resources, and prompts. Actions: 'search' finds capabilities " +
  "across servers by keyword (ranked, capped - the only discovery path), 'call' runs one " +
  "external tool by its qualified name '<server>:<tool>' (e.g. 'github:create_issue'), " +
  "'resources' lists attributable context records (pass server + uri to read one), 'prompt' " +
  "lists prompts (pass name '<server>:<prompt>' + args to expand one), 'status' reports " +
  "per-server health. Always address a capability by its qualified '<server>:<name>' identity. " +
  "Prefer Trevor's built-in tools when they fit; use mcp only for configured external " +
  "integrations. External calls may change external services and run serially.";

const inputError = (detail: string): Effect.Effect<never, ToolError> =>
  Effect.fail(new ToolInputError({ tool: "mcp", detail }));

/** Clips a description onto one list line; newlines flattened, overlong text cut with an ellipsis. */
function clipLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LINE_DESCRIPTION_CHARS ? `${flat.slice(0, LINE_DESCRIPTION_CHARS)}…` : flat;
}

function searchLine(record: McpCapabilityRecord): string {
  const description = record.description ? ` ${clipLine(record.description)}` : "";
  return `- ${record.qualifiedName} [${record.kind}]${description}`;
}

function resourceLine(record: McpResourceRecord): string {
  const mime = record.mimeType ? ` (${record.mimeType})` : "";
  const description = record.description ? ` - ${clipLine(record.description)}` : "";
  return `- ${record.qualifiedName} ${record.uri}${mime}${description}`;
}

function promptLine(record: McpPromptRecord): string {
  const description = record.description ? ` - ${clipLine(record.description)}` : "";
  return `- ${record.qualifiedName}${description}`;
}

function renderResource(record: McpResourceContext): string {
  const mime = record.mimeType ? ` (${record.mimeType})` : "";
  const truncated = record.truncated ? " [truncated]" : "";
  return `${record.server} ${record.uri}${mime}${truncated}\n${record.text}`;
}

function renderPromptArtifact(artifact: McpPromptArtifact): string {
  const header = `${artifact.qualifiedName}${artifact.description ? ` - ${artifact.description}` : ""}`;
  const messages = artifact.messages.map((message) => `[${message.role}]\n${message.text}`);
  const truncated = artifact.truncated ? "\n[truncated]" : "";
  return [header, ...messages].join("\n\n") + truncated;
}

function statusLine(entry: McpServerStatusEntry): string {
  const caps = entry.capabilities;
  const counts = caps.discovered
    ? ` · tools ${caps.counts.tools} / resources ${caps.counts.resources} / prompts ${caps.counts.prompts}` +
      (caps.discoveredAt !== undefined
        ? ` · discovered ${new Date(caps.discoveredAt).toISOString()}`
        : "")
    : "";
  const protocol = entry.protocolVersion ? ` · protocol ${entry.protocolVersion}` : "";
  const lastError = entry.lastError ? ` · last error: ${entry.lastError}` : "";
  const disabled = entry.enabled ? "" : " (disabled)";
  return `- ${entry.server} [${entry.transport} ${entry.target}] ${entry.status}${disabled}${protocol}${counts}${lastError}`;
}

/** Builds the mcp tool over a runtime; tools/index.ts binds the host singleton. */
export function buildMcpTool(runtime: McpRuntime): Tool<McpArgs> {
  /** The clean unconfigured/disabled degradation every action shares. */
  const unusable = (): string | null => {
    const entries = runtime.statusSnapshot();
    if (entries.length === 0) {
      return (
        "No MCP servers are configured. MCP connects Trevor to external integrations; " +
        `the user can add named servers in ${abbrevHome(USER_MCP_SERVERS_JSON)}.`
      );
    }
    if (entries.every((entry) => !entry.enabled)) {
      return (
        `All ${entries.length} configured MCP server(s) are disabled. ` +
        `Enable one in ${abbrevHome(USER_MCP_SERVERS_JSON)} to use MCP.`
      );
    }
    return null;
  };

  /** Discovers any enabled, not-yet-discovered server, tolerantly: one unreachable server
   *  contributes nothing (its failure lands in the status snapshot), never blocks the rest. */
  const ensureDiscovered = (): Effect.Effect<void> =>
    Effect.promise(async () => {
      const pending = runtime
        .statusSnapshot()
        .filter((entry) => entry.enabled && !entry.capabilities.discovered);
      await Promise.all(
        pending.map((entry) =>
          runtime.capabilities.refreshCapabilities(entry.server).catch(() => undefined),
        ),
      );
    });

  const search = (args: McpArgs): Effect.Effect<string, ToolError> => {
    const query = args.query?.trim() ?? "";
    if (query.length === 0) {
      return inputError(
        "the search action needs a query - MCP catalogs are exposed only through capped search, never listed wholesale",
      );
    }
    const limit = clamp(args.limit, 1, MAX_MCP_SEARCH_RESULTS, DEFAULT_MCP_SEARCH_LIMIT);
    return ensureDiscovered().pipe(
      Effect.map(() => {
        const records = runtime.capabilities.searchCapabilities(query, { limit });
        if (records.length === 0) {
          return `no MCP capabilities match "${query}"`;
        }
        const header = `${records.length} MCP capabilit${records.length === 1 ? "y" : "ies"} matching "${query}" (limit ${limit})`;
        return [header, ...records.map(searchLine)].join("\n");
      }),
    );
  };

  const call = (args: McpArgs): Effect.Effect<string, ToolError> => {
    if (!args.name) {
      return inputError(
        "the call action needs the qualified tool name '<server>:<tool>' (find one with the search action)",
      );
    }
    return runtime.callTool(args.name, args.args);
  };

  const resources = (args: McpArgs): Effect.Effect<string, ToolError> => {
    if (args.uri !== undefined) {
      if (!args.server) {
        return inputError("reading a resource needs both server and uri");
      }
      // No re-cap: the runtime already bounds the resource text; only a short header is added.
      return runtime.readResource(args.server, args.uri).pipe(Effect.map(renderResource));
    }
    return runtime
      .listResources(args.server)
      .pipe(
        Effect.map((records) =>
          cap(
            records.length === 0
              ? "no MCP resources are available"
              : [`${records.length} MCP resource(s)`, ...records.map(resourceLine)].join("\n"),
          ),
        ),
      );
  };

  const prompt = (args: McpArgs): Effect.Effect<string, ToolError> => {
    if (args.name !== undefined) {
      // MCP prompt arguments are strings per the spec; lenient values are stringified.
      const stringArgs = args.args
        ? Object.fromEntries(Object.entries(args.args).map(([key, value]) => [key, String(value)]))
        : undefined;
      // No re-cap: the runtime already bounds the prompt expansion.
      return runtime.getPrompt(args.name, stringArgs).pipe(Effect.map(renderPromptArtifact));
    }
    return runtime
      .listPrompts(args.server)
      .pipe(
        Effect.map((records) =>
          cap(
            records.length === 0
              ? "no MCP prompts are available"
              : [`${records.length} MCP prompt(s)`, ...records.map(promptLine)].join("\n"),
          ),
        ),
      );
  };

  const status = (): Effect.Effect<string, ToolError> =>
    Effect.sync(() => {
      const entries = runtime.statusSnapshot();
      const enabled = entries.filter((entry) => entry.enabled).length;
      const header = `${entries.length} MCP server(s) configured (${enabled} enabled)`;
      return [header, ...entries.map(statusLine)].join("\n");
    });

  return {
    name: "mcp",
    description: MCP_DESCRIPTION,
    params: McpParams,
    // readOnly stays unset (D-008): an external MCP call mutates external service state.
    execute: (args) =>
      Effect.suspend(() => {
        const degraded = unusable();
        if (degraded !== null) {
          return Effect.succeed(degraded);
        }
        switch (args.action) {
          case "search":
            return search(args).pipe(Effect.map(cap));
          case "call":
            return call(args); // the runtime already bounds call output
          case "resources":
            return resources(args);
          case "prompt":
            return prompt(args);
          case "status":
            return status().pipe(Effect.map(cap));
        }
      }),
  };
}
