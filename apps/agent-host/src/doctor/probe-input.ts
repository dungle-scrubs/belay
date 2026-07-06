import type { CwdLockDoctorFact } from "@host/session/cwd-lock";
import type { DoctorFinding, InternetSnapshot } from "@trevor/session";
import type { RootCategoryId } from "@trevor/session/node-paths";
import type { AdmissionDoctorSummary } from "../admission/doctor";
import type { ProviderIncidentCategory } from "../providers/provider-incidents";
import type { ResidencyDoctorSummary } from "../residency/doctor";

/**
 * The probed-fact input contract for the `doctor.current` snapshot fold (D-073): {@link
 * DoctorProbeInput} and the component summaries it aggregates. Every field here is already a
 * sanitized fact - booleans, counts, enums, redacted one-liners - fed in by build.ts's bounded,
 * redacted probing; nothing in this module reads live state itself.
 *
 * Responsible for: the DoctorProbeInput contract (and its component summary types) build.ts
 * fills and the area builders fold.
 * Not for: probing - build.ts - or folding facts into areas - the areas-* modules.
 */

/** One provider's probed reachability, fed in by the command handler. */
export interface DoctorProviderProbe {
  readonly key: string;
  readonly label: string;
  readonly model: string;
  readonly kind: "local" | "cloud";
  readonly status: "warm" | "cold" | "unreachable";
}

/** The telemetry mode + exporter health for the Telemetry area (plan 13 M7). Redaction-safe by
 *  construction: it carries booleans + counts + the exporter NAME, never a DSN, endpoint, or path. */
export interface TelemetryDoctorSummary {
  readonly exporter: "none" | "file" | "otlp";
  readonly remoteEnabled: boolean;
  /** Whether a Sentry DSN is configured - the boolean only, never the DSN value. */
  readonly sentryConfigured: boolean;
  readonly providerTrace: boolean;
  /** Why remote telemetry is force-off (test/ci), or null. */
  readonly suppressed: "test" | "ci" | null;
  /** Exporter records dropped (byte cap / write failure) since start; 0 when disabled or healthy. */
  readonly drops: number;
  /** The redaction self-test result: does `safeAttributes` drop a known-sensitive probe key. */
  readonly redactionOk: boolean;
}

/** A probed filesystem root for the Storage/Roots area: its sanitized path + health. */
export interface DoctorRootProbe {
  readonly id: RootCategoryId;
  readonly label: string;
  readonly ownership: "trevor" | "external";
  readonly path: string | null; // already sanitized (home-abbreviated); null for browser
  readonly exists: boolean;
  readonly writable: boolean | null; // null when not applicable/not probed (external, legacy, browser)
  readonly overridden: boolean;
  readonly migrationAvailable: boolean; // legacy only: importable ~/.trevor data present
}

export interface StoreDiagPayload {
  readonly indexHealthy: boolean;
  readonly queries: number;
  readonly schemaVersion: number;
  readonly slowQueries: number;
  readonly startupSha: string | null;
}

export type StoreDiagProbe =
  | {
      readonly kind: "ok";
      readonly diag: StoreDiagPayload;
      readonly hostSha: string | null;
    }
  | {
      readonly kind: "unknown";
      readonly hostSha: string | null;
      readonly reason: string;
    };

export interface DoctorProbeInput {
  readonly host: { readonly instanceId: string; readonly role: string; readonly live: boolean };
  /** The live turn-machine facts (active run, queue, last termination), already string-formatted. */
  readonly session: {
    readonly activeRun?: string;
    readonly queued?: number;
    readonly lastTurn?: string;
    readonly compacting?: boolean;
  };
  readonly providers: readonly DoctorProviderProbe[];
  readonly internet: InternetSnapshot;
  readonly tools: readonly string[];
  readonly workspace: {
    readonly cwd: string;
    readonly workspace: string;
    readonly branch?: string;
    /** Cwd advisory-lock state for this host's working directory (plan 01); absent when not probed. */
    readonly cwdLock?: CwdLockDoctorFact;
  };
  readonly storage: {
    readonly roots: readonly DoctorRootProbe[];
    readonly store?: StoreDiagProbe;
  };
  /** Local-model admission state (plan 11): active owners, queue depth, oldest wait; absent when not
   *  probed (e.g. no local provider in use). */
  readonly admission?: AdmissionDoctorSummary;
  /** Local-model residency state (plan 11.1): Trevor-loaded models, their context caps + live claim
   *  counts, and the last eviction; folded into the Local-admission area. Absent when not probed. */
  readonly residency?: ResidencyDoctorSummary;
  /** Telemetry mode + exporter health (plan 13 M7): exporter, remote/Sentry/provider-trace on-off, drop
   *  count, and the redaction self-test - never a DSN, endpoint, prompt, or path. Absent when not probed. */
  readonly telemetry?: TelemetryDoctorSummary;
  readonly build: DoctorBuildInfo;
  readonly peripherals: DoctorPeripherals;
  /** Stored LSP diagnostics counts (plan 24 M8): how many files carry diagnostics plus the
   *  error/warning totals - counts only, never a message or a path. Errors surface as the LSP
   *  area's diagnostic-warning finding (D-008). Absent when nothing is stored / not probed. */
  readonly lspDiagnostics?: DoctorLspDiagnostics;
  /** The Hooks area's extra findings (plan 25 M9, D-009): approval/missing-script/performance/
   *  config/legacy-migration warnings from the hooks-status fold. Absent when not probed. */
  readonly hooksFindings?: readonly DoctorFinding[];
  readonly web: DoctorWebDocs;
  /** Redacted provider-failure observation counts (D-076 M5/M6): distinct unclassified shapes and
   *  total sightings, shown as a Providers fact. Counts + fingerprint ids only - never any secret. */
  readonly observations?: DoctorObservations;
  /** Recent provider-failure outcomes (D-076 M6): retry-exhausted vs non-retryable-terminal counts,
   *  surfaced as DISTINCT Providers findings so a transient outage that gave up reads differently from
   *  an auth/quota/rejected failure that was never eligible for retry. */
  readonly providerFailures?: DoctorProviderFailures;
  /** The latest incident per provider (D-007): the most recent structured diagnostic, categorized for
   *  an actionable finding. Distinct from the {@link DoctorProviderFailures} COUNTS - this is the
   *  single most-recent incident per provider with its sanitized detail, and it includes malformed
   *  -protocol anomalies that never reach the failure ring (they are not provider errors). */
  readonly providerIncidents?: readonly DoctorProviderIncident[];
  /** D-065 catalog SOURCES (provider/runtime/subscription auth + config state). The legacy `providers`
   *  roster above lists only the configured runnable providers, so an unconfigured/expired/rejected
   *  source is invisible there; these surface its auth/setup state (status + counts only, never a key). */
  readonly catalogSources?: readonly DoctorCatalogSource[];
  readonly checkedAt: string;
}

/** One D-065 catalog source's auth/config state for the Providers area (redaction-safe: no key value). */
export interface DoctorCatalogSource {
  readonly sourceId: string;
  readonly label: string;
  /** local | oauth | api-key | gateway. */
  readonly type: string;
  /** ready | needs-auth | error | unavailable. */
  readonly status: string;
  /** authenticated | none | expired. */
  readonly auth: string;
  readonly modelCount: number;
}

/** A provider's latest incident, projected redaction-safe for the Providers area (D-007). */
export interface DoctorProviderIncident {
  readonly provider: string;
  readonly model?: string;
  readonly category: ProviderIncidentCategory;
  /** The typed incident reason (e.g. transport_loss, auth, protocol_anomaly). */
  readonly reason: string;
  /** The sanitized one-line upstream detail (already redacted at the provider boundary). */
  readonly detail: string;
  readonly attempt: number;
  /** ISO timestamp the incident was recorded. */
  readonly at: string;
}

/** The compact, redaction-safe observation-corpus summary the Providers area surfaces (D-076 M6 / plan 29 M4). */
export interface DoctorObservations {
  readonly distinct: number;
  readonly unknown: number;
  readonly total: number;
  /** The busiest shape fingerprints by count - stable shape ids only, never a message or secret. */
  readonly top?: readonly { readonly fingerprint: string; readonly count: number }[];
}

/** Recent terminal provider-failure counts, kept in two distinct buckets (D-076 M6). */
export interface DoctorProviderFailures {
  /** Recent failures that exhausted the bounded reconnect budget (a transient outage that gave up). */
  readonly retryExhausted: number;
  /** Recent terminal failures never eligible for retry (auth, quota, rejected, model/runtime down). */
  readonly nonRetryableTerminal: number;
  /** A sanitized one-line detail of the most recent of each, for the finding message. */
  readonly lastRetryExhausted?: string;
  readonly lastTerminal?: string;
}

/**
 * Web / Docs dependency facts (D-073, plan 04). Booleans + readiness ENUMS only - never key values -
 * so the area stays redaction-safe: whether a web-search key is configured, the web_fetch backend
 * ladder's readiness (static always; Jina keyless-available vs keyed; Firecrawl configured-only), an
 * optional sanitized last-backend error category, and the docs-cache presence/staleness.
 */
export interface DoctorWebDocs {
  readonly searchConfigured: boolean;
  /** The web_fetch backend ladder's readiness, reported per backend (no key values). */
  readonly fetch: {
    /** Static fetch needs no configuration, so it is always available. */
    readonly staticAvailable: boolean;
    /** Jina works keyless ("available"); "keyed" when JINA_API_KEY adds the Authorization header. */
    readonly jina: "available" | "keyed";
    /** Firecrawl is gated entirely behind FIRECRAWL_API_KEY presence. */
    readonly firecrawl: "configured" | "unconfigured";
    /** The sanitized category of the last web_fetch backend error, if any has been observed. */
    readonly lastError?: string;
  };
  readonly docs: { readonly present: boolean; readonly stale: boolean };
}

/** Package/build/version facts for the Updates / Version area (D-073). `version` is null in a dev build. */
export interface DoctorBuildInfo {
  readonly version: string | null;
  readonly node: string;
  readonly runtime: string;
}

/**
 * The lifecycle state of a peripheral subsystem (MCP / LSP / Hooks) the host may integrate (D-073).
 * `unconfigured` is the steady "not set up" state (not an error); the rest carry an optional
 * sanitized detail. This is the closed set of states the dashboard renders for these areas.
 */
export type PeripheralState =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "ready"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail?: string }
  | { readonly kind: "auth-needed"; readonly detail?: string }
  | { readonly kind: "error"; readonly detail?: string }
  | { readonly kind: "timeout"; readonly detail?: string };

/** The peripheral-subsystem states fed to the MCP / LSP / Hooks areas. */
export interface DoctorPeripherals {
  readonly mcp: PeripheralState;
  readonly lsp: PeripheralState;
  readonly hooks: PeripheralState;
}

/** Bounded stored-LSP-diagnostics counts for the LSP area (plan 24 M8). Redaction-safe by
 *  construction: counts only, never a diagnostic message, file path, or code. */
export interface DoctorLspDiagnostics {
  readonly files: number;
  readonly errors: number;
  readonly warnings: number;
}
