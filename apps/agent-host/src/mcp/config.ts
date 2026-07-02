import { asPositiveInt } from "@host/boot/coerce";
import { loadJsonConfig } from "@host/boot/config";
import { asNonEmptyString, asRecord } from "@host/boot/decode";
import { USER_MCP_SERVERS_JSON } from "@host/boot/paths";

/**
 * The normalized MCP server config model (plan 23 M1). MCP is a generalized host-owned runtime
 * (D-001): every server - including tool-proxy - is an ordinary named entry in
 * `<TREVOR_HOME>/mcp-servers.json` (`{ "servers": { "<name>": { ... } } }`), following the
 * host's optional-JSON-config precedent (admission.json, models.json). Normalization is a
 * tolerant pure decoder in the loadJsonConfig tradition: a malformed entry is dropped with a
 * STRUCTURED issue (never a crash, never a bare string), so one typo cannot take out the rest
 * of the registry. Server names feed the qualified capability identity `server:tool` (D-005),
 * so a name may not contain `:` or whitespace.
 *
 * Responsible for: the normalized McpServerConfig model - parsing, validation issues, the
 * redacted inspection projection, and loading mcp-servers.json.
 * Not for: server lookup/filtering (./registry) or transport construction (./stdio-transport).
 */

/** Which capability families a server is allowed to expose to the host (D-002). */
export interface McpExposure {
  readonly tools: boolean;
  readonly resources: boolean;
  readonly prompts: boolean;
}

/** Static auth material for an http server; secrets never leave the config boundary unredacted. */
export interface McpAuthConfig {
  readonly bearerToken?: string;
  readonly oauth?: { readonly clientId: string };
}

export interface McpStdioServerConfig {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  /** Explicit per-server child env, layered over the D-004 allowlist by the stdio transport. */
  readonly env: Readonly<Record<string, string>>;
  readonly exposure: McpExposure;
  readonly requestTimeoutMs: number;
  /** Server-originated sampling (sampling/createMessage) opt-in. OFF unless the entry says
   *  `"sampling": true`; the flag is only ever PRESENT (as `true`) when opted in, so the
   *  default is structural - absent means denied (plan 23 M6). Note: the HOST-side sampling
   *  handler seam is wired by a later surface; until then an opted-in server is still denied
   *  (the host has sampling disabled), and this flag alone cannot enable it. */
  readonly sampling?: true;
}

export interface McpHttpServerConfig {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: "http";
  readonly endpoint: string;
  readonly auth?: McpAuthConfig;
  readonly exposure: McpExposure;
  readonly requestTimeoutMs: number;
  /** Server-originated sampling opt-in; see McpStdioServerConfig.sampling. */
  readonly sampling?: true;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpConfigIssueKind =
  | "invalid_shape"
  | "invalid_name"
  | "duplicate_name"
  | "invalid_transport"
  | "missing_command"
  | "invalid_endpoint";

/** A structured validation finding: which entry was dropped and why, as data (not a throw). */
export interface McpConfigIssue {
  readonly kind: McpConfigIssueKind;
  readonly server: string;
  readonly detail: string;
}

export interface McpServersConfig {
  readonly servers: readonly McpServerConfig[];
  readonly issues: readonly McpConfigIssue[];
}

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;

export const EMPTY_MCP_SERVERS_CONFIG: McpServersConfig = { servers: [], issues: [] };

const ALL_EXPOSED: McpExposure = { tools: true, resources: true, prompts: true };

/** No `:` (reserved by the `server:tool` qualified identity, D-005), no whitespace, no empties. */
const VALID_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Tolerantly decodes a raw `mcp-servers.json` value into the normalized model. Every dropped
 * entry is reported as a structured {@link McpConfigIssue}; well-formed siblings survive. Pure.
 */
export function normalizeMcpServersConfig(raw: unknown): McpServersConfig {
  const root = asRecord(raw);
  if (!root || root.servers === undefined) {
    return EMPTY_MCP_SERVERS_CONFIG;
  }
  const entries = asRecord(root.servers);
  if (!entries) {
    return {
      servers: [],
      issues: [{ kind: "invalid_shape", server: "", detail: "servers must be an object" }],
    };
  }

  const servers: McpServerConfig[] = [];
  const issues: McpConfigIssue[] = [];
  const seen = new Set<string>();

  for (const [rawName, rawEntry] of Object.entries(entries)) {
    const name = rawName.trim();
    if (!VALID_SERVER_NAME.test(name)) {
      issues.push({
        kind: "invalid_name",
        server: name,
        detail: `server name "${rawName}" must match ${String(VALID_SERVER_NAME)} (":" is reserved for qualified identity)`,
      });
      continue;
    }
    if (seen.has(name)) {
      issues.push({
        kind: "duplicate_name",
        server: name,
        detail: `duplicate server name "${name}"; first entry wins`,
      });
      continue;
    }
    const outcome = normalizeServer(name, rawEntry);
    if ("issue" in outcome) {
      issues.push(outcome.issue);
      continue;
    }
    seen.add(name);
    servers.push(outcome.server);
  }

  return { servers, issues };
}

/** Loads + normalizes `<TREVOR_HOME>/mcp-servers.json`; absent or malformed means no servers. */
export function loadMcpServersConfig(read?: (path: string) => string): McpServersConfig {
  return loadJsonConfig(
    USER_MCP_SERVERS_JSON,
    normalizeMcpServersConfig,
    EMPTY_MCP_SERVERS_CONFIG,
    read,
  );
}

export type RedactedMcpServerConfig =
  | (Omit<McpStdioServerConfig, "env"> & { readonly env: Readonly<Record<string, "[redacted]">> })
  | (Omit<McpHttpServerConfig, "auth"> & {
      readonly auth?: {
        readonly bearerToken?: "[redacted]";
        readonly oauth?: { readonly clientId: string };
      };
    });

/**
 * The debug/inspection projection (D-009): shape stays readable (names, commands, env KEYS,
 * endpoint host + path), secret VALUES do not survive - env values and bearer tokens are
 * masked, endpoint userinfo/query/fragment are stripped.
 */
export function redactMcpServerConfig(server: McpServerConfig): RedactedMcpServerConfig {
  if (server.transport === "stdio") {
    return {
      ...server,
      env: Object.fromEntries(Object.keys(server.env).map((key) => [key, "[redacted]" as const])),
    };
  }
  const { auth, ...rest } = server;
  return {
    ...rest,
    endpoint: redactMcpEndpoint(server.endpoint),
    ...(auth
      ? {
          auth: {
            ...(auth.bearerToken ? { bearerToken: "[redacted]" as const } : {}),
            ...(auth.oauth ? { oauth: { clientId: auth.oauth.clientId } } : {}),
          },
        }
      : {}),
  };
}

function normalizeServer(
  name: string,
  rawEntry: unknown,
): { server: McpServerConfig } | { issue: McpConfigIssue } {
  const entry = asRecord(rawEntry);
  if (!entry) {
    return {
      issue: { kind: "invalid_shape", server: name, detail: "server entry must be an object" },
    };
  }

  const enabled = typeof entry.enabled === "boolean" ? entry.enabled : true;
  const exposure = normalizeExposure(entry.exposure);
  const requestTimeoutMs = asPositiveInt(entry.requestTimeoutMs) ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  // Sampling stays a structural opt-in: anything but a literal `true` (absent, false, junk)
  // normalizes to an ABSENT flag, so a typo can never silently enable server-originated model calls.
  const sampling = entry.sampling === true ? ({ sampling: true } as const) : {};

  if (entry.transport === "stdio") {
    const command = asNonEmptyString(entry.command);
    if (!command) {
      return {
        issue: {
          kind: "missing_command",
          server: name,
          detail: "a stdio server requires a command",
        },
      };
    }
    return {
      server: {
        name,
        enabled,
        transport: "stdio",
        command,
        args: stringArray(entry.args),
        env: stringRecord(entry.env),
        exposure,
        requestTimeoutMs,
        ...sampling,
      },
    };
  }

  if (entry.transport === "http") {
    const endpoint = asHttpEndpoint(entry.endpoint);
    if (!endpoint) {
      return {
        issue: {
          kind: "invalid_endpoint",
          server: name,
          detail: "an http server requires a parseable http(s) endpoint URL",
        },
      };
    }
    const auth = normalizeAuth(entry.auth);
    return {
      server: {
        name,
        enabled,
        transport: "http",
        endpoint,
        ...(auth ? { auth } : {}),
        exposure,
        requestTimeoutMs,
        ...sampling,
      },
    };
  }

  return {
    issue: {
      kind: "invalid_transport",
      server: name,
      detail: `unknown transport ${JSON.stringify(entry.transport)}; expected "stdio" or "http"`,
    },
  };
}

function normalizeExposure(raw: unknown): McpExposure {
  const record = asRecord(raw);
  return {
    tools: typeof record?.tools === "boolean" ? record.tools : ALL_EXPOSED.tools,
    resources: typeof record?.resources === "boolean" ? record.resources : ALL_EXPOSED.resources,
    prompts: typeof record?.prompts === "boolean" ? record.prompts : ALL_EXPOSED.prompts,
  };
}

function normalizeAuth(raw: unknown): McpAuthConfig | undefined {
  const record = asRecord(raw);
  const bearerToken = asNonEmptyString(record?.bearerToken);
  const clientId = asNonEmptyString(asRecord(record?.oauth)?.clientId);
  if (!bearerToken && !clientId) {
    return undefined;
  }
  return {
    ...(bearerToken ? { bearerToken } : {}),
    ...(clientId ? { oauth: { clientId } } : {}),
  };
}

/** Keeps origin + path; drops userinfo, query, and fragment (secrets ride in all three).
 *  Shared with the transports: any endpoint that reaches an error message or debug line goes
 *  through here first. */
export function redactMcpEndpoint(endpoint: string): string {
  const url = new URL(endpoint); // normalization guaranteed a parseable http(s) URL
  return `${url.origin}${url.pathname}`;
}

function asHttpEndpoint(raw: unknown): string | undefined {
  const value = asNonEmptyString(raw);
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(raw: unknown): Readonly<Record<string, string>> {
  const record = asRecord(raw);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
