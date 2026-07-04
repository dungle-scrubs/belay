/**
 * Responsible for: the normalized indexed source-recall provider config (plan 38 M8) - parsing,
 * validation issues, the redacted inspection projection, and loading `source-recall.json` from the
 * approved config root (`TREVOR_HOME`, D-081). Every backend - `source-recall` daemon, Aleutian Trace
 * - is an ordinary named entry in `<TREVOR_HOME>/source-recall.json`
 * (`{ providers: { "<id>": { kind, endpoint, ... } } }`), following the host's optional-JSON-config
 * precedent (admission.json, mcp-servers.json). Normalization is a tolerant pure decoder: a malformed
 * entry is dropped with a STRUCTURED issue (never a crash, never a bare string), so one typo cannot
 * take out the rest of the registry. This config holds endpoints + repo/project mapping only - NO
 * secrets (the local daemons are unauthenticated), and the redaction still strips endpoint
 * userinfo/query/fragment defensively.
 *
 * Not for: adapter construction / selection (registry.ts) or the HTTP transport (http.ts).
 */
import { asPositiveInt } from "@host/boot/coerce";
import { loadJsonConfig } from "@host/boot/config";
import { asNonEmptyString, asRecord, asStringArray } from "@host/boot/decode";
import { USER_SOURCE_RECALL_JSON } from "@host/boot/paths";
import { SOURCE_RECALL_PROVIDER_KINDS, type SourceRecallProviderKind } from "@trevor/session";

/** One normalized source-recall provider entry, keyed by its config id. */
export interface SourceRecallProviderConfig {
  readonly id: string;
  readonly kind: SourceRecallProviderKind;
  readonly endpoint: string;
  readonly enabled: boolean;
  readonly timeoutMs: number;
  /** Deterministic selection order (lower wins); defaults to declaration order. */
  readonly priority: number;
  /** `source-recall`: the repo name to scope queries to when the daemon serves multiple repos. */
  readonly repo?: string;
  /** `aleutian`: HTTP Trace vs the stdio trace-mcp binary. Defaults to `http`. */
  readonly transport?: "http" | "mcp";
  /** `aleutian`: the project root a graph is initialized for. */
  readonly projectRoot?: string;
  /** `aleutian`: languages to parse on init. */
  readonly languages?: readonly string[];
}

export type SourceRecallConfigIssueKind =
  | "invalid_shape"
  | "invalid_id"
  | "duplicate_id"
  | "invalid_kind"
  | "invalid_endpoint"
  | "invalid_transport";

/** A structured validation finding: which entry was dropped and why, as data (not a throw). */
export interface SourceRecallConfigIssue {
  readonly kind: SourceRecallConfigIssueKind;
  readonly provider: string;
  readonly detail: string;
}

export interface SourceRecallConfig {
  readonly providers: readonly SourceRecallProviderConfig[];
  readonly issues: readonly SourceRecallConfigIssue[];
}

/** Per-kind default request timeout: Aleutian init/context is heavier than a warm chunk query. */
const DEFAULT_TIMEOUT_MS: Record<SourceRecallProviderKind, number> = {
  "source-recall": 10_000,
  aleutian: 30_000,
};

export const EMPTY_SOURCE_RECALL_CONFIG: SourceRecallConfig = { providers: [], issues: [] };

/** No `:`/whitespace, no empties - the id becomes the stable provider id `<id>` in diagnostics. */
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const KINDS: ReadonlySet<string> = new Set(SOURCE_RECALL_PROVIDER_KINDS);

/**
 * Tolerantly decodes a raw `source-recall.json` value into the normalized config. Every dropped entry
 * is reported as a structured {@link SourceRecallConfigIssue}; well-formed siblings survive. Pure.
 */
export function normalizeSourceRecallConfig(raw: unknown): SourceRecallConfig {
  const root = asRecord(raw);
  if (!root || root.providers === undefined) {
    return EMPTY_SOURCE_RECALL_CONFIG;
  }
  const entries = asRecord(root.providers);
  if (!entries) {
    return {
      providers: [],
      issues: [{ kind: "invalid_shape", provider: "", detail: "providers must be an object" }],
    };
  }

  const providers: SourceRecallProviderConfig[] = [];
  const issues: SourceRecallConfigIssue[] = [];
  const seen = new Set<string>();
  let index = 0;

  for (const [rawId, rawEntry] of Object.entries(entries)) {
    const id = rawId.trim();
    if (!VALID_ID.test(id)) {
      issues.push({
        kind: "invalid_id",
        provider: id,
        detail: `provider id "${rawId}" must match ${String(VALID_ID)}`,
      });
      continue;
    }
    if (seen.has(id)) {
      issues.push({
        kind: "duplicate_id",
        provider: id,
        detail: `duplicate provider id "${id}"; first wins`,
      });
      continue;
    }
    const outcome = normalizeProvider(id, rawEntry, index);
    if ("issue" in outcome) {
      issues.push(outcome.issue);
      continue;
    }
    seen.add(id);
    providers.push(outcome.provider);
    index += 1;
  }

  return { providers, issues };
}

/** Loads + normalizes `<TREVOR_HOME>/source-recall.json`; absent or malformed means no providers. */
export function loadSourceRecallConfig(read?: (path: string) => string): SourceRecallConfig {
  return loadJsonConfig(
    USER_SOURCE_RECALL_JSON,
    normalizeSourceRecallConfig,
    EMPTY_SOURCE_RECALL_CONFIG,
    read,
  );
}

function normalizeProvider(
  id: string,
  rawEntry: unknown,
  declarationIndex: number,
): { provider: SourceRecallProviderConfig } | { issue: SourceRecallConfigIssue } {
  const entry = asRecord(rawEntry);
  if (!entry) {
    return {
      issue: { kind: "invalid_shape", provider: id, detail: "provider entry must be an object" },
    };
  }
  if (typeof entry.kind !== "string" || !KINDS.has(entry.kind)) {
    return {
      issue: {
        kind: "invalid_kind",
        provider: id,
        detail: `kind must be one of ${SOURCE_RECALL_PROVIDER_KINDS.join(", ")}`,
      },
    };
  }
  const kind = entry.kind as SourceRecallProviderKind;

  const transport = normalizeTransport(entry.transport);
  if (kind === "aleutian" && transport === undefined && entry.transport !== undefined) {
    return {
      issue: {
        kind: "invalid_transport",
        provider: id,
        detail: 'transport must be "http" or "mcp"',
      },
    };
  }

  // An `mcp`-transport Aleutian provider has no HTTP endpoint; every other entry requires one.
  const needsEndpoint = !(kind === "aleutian" && transport === "mcp");
  const endpoint = asHttpEndpoint(entry.endpoint);
  if (needsEndpoint && !endpoint) {
    return {
      issue: {
        kind: "invalid_endpoint",
        provider: id,
        detail: "a parseable http(s) endpoint URL is required",
      },
    };
  }

  const enabled = typeof entry.enabled === "boolean" ? entry.enabled : true;
  const timeoutMs = asPositiveInt(entry.timeoutMs) ?? DEFAULT_TIMEOUT_MS[kind];
  const priority = asPositiveInt(entry.priority) ?? declarationIndex;
  const repo = asNonEmptyString(entry.repo);
  const projectRoot = asNonEmptyString(entry.projectRoot);
  const languages = asStringArray(entry.languages);

  return {
    provider: {
      id,
      kind,
      endpoint: endpoint ?? "",
      enabled,
      timeoutMs,
      priority,
      ...(repo ? { repo } : {}),
      ...(kind === "aleutian" ? { transport: transport ?? "http" } : {}),
      ...(projectRoot ? { projectRoot } : {}),
      ...(languages.length > 0 ? { languages } : {}),
    },
  };
}

function normalizeTransport(raw: unknown): "http" | "mcp" | undefined {
  return raw === "http" || raw === "mcp" ? raw : undefined;
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

export type RedactedSourceRecallProvider = Omit<SourceRecallProviderConfig, "endpoint"> & {
  readonly endpoint: string;
};

/**
 * The debug/inspection projection: shape stays readable (id, kind, transport, repo/project mapping,
 * endpoint origin + path), while any endpoint userinfo/query/fragment is stripped defensively - even
 * though these local daemons carry no secrets, the redaction path is the single owner of what a
 * config endpoint looks like in a diagnostic line.
 */
export function redactSourceRecallProvider(
  provider: SourceRecallProviderConfig,
): RedactedSourceRecallProvider {
  return { ...provider, endpoint: redactEndpoint(provider.endpoint) };
}

/** Keeps origin + path; drops userinfo, query, and fragment. */
export function redactEndpoint(endpoint: string): string {
  if (!endpoint) {
    return "";
  }
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return "[unparseable endpoint]";
  }
}
