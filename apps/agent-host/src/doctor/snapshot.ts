import {
  type DoctorArea,
  type DoctorAreaId,
  type DoctorFact,
  type DoctorFinding,
  type DoctorNextAction,
  type DoctorSnapshot,
  type DoctorStatus,
  type InternetSnapshot,
  rollupStatus,
} from "@trevor/session";
import type { RootCategoryId } from "@trevor/session/node-paths";
import type { AdmissionDoctorSummary } from "../admission/doctor";
import {
  CWD_LOCK_FORCE_CLEAR_HINT,
  type CwdLockDoctorFact,
  cwdLockSummary,
  isCwdLockWarn,
} from "../cwd-lock";
import type { ProviderIncidentCategory } from "../providers/provider-incidents";

/**
 * Builds the structured `doctor.current` snapshot (D-073) from already-probed host facts. PURE over
 * its input so the area/finding/severity construction is deterministic and unit-testable; the
 * command handler owns the bounded, redacted probing (provider readiness, storage writeability) and
 * feeds the results here. Areas the first cut does not probe (web/docs, MCP, LSP, hooks, updates)
 * are reported `not_checked` rather than omitted, so the dashboard always shows the full grid.
 *
 * This is health + repair guidance, NOT raw runtime internals (that stays in host.debugInfo): every
 * value here is a sanitized fact, and findings carry a next action where one applies.
 */

/** One provider's probed reachability, fed in by the command handler. */
export interface DoctorProviderProbe {
  readonly key: string;
  readonly label: string;
  readonly model: string;
  readonly kind: "local" | "cloud";
  readonly status: "warm" | "cold" | "unreachable";
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
  readonly storage: { readonly roots: readonly DoctorRootProbe[] };
  /** Local-model admission state (plan 11): active owners, queue depth, oldest wait; absent when not
   *  probed (e.g. no local provider in use). */
  readonly admission?: AdmissionDoctorSummary;
  readonly build: DoctorBuildInfo;
  readonly peripherals: DoctorPeripherals;
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

/** The compact, redaction-safe provider-observation summary the Providers area surfaces (D-076 M6). */
export interface DoctorObservations {
  readonly distinct: number;
  readonly unknown: number;
  readonly total: number;
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

/**
 * The four actionable provider-incident categories (D-007), each with the finding title, one-line
 * verdict, and repair action it drives. Provider-neutral: the category is a typed value the loop
 * derived, never a DeepSeek-specific string, so a new provider with the same failure shape reuses
 * the same finding copy. The leaked/upstream detail rides as the finding's collapsed evidence.
 */
const INCIDENT_CATEGORY: Record<
  ProviderIncidentCategory,
  { readonly title: string; readonly message: string; readonly nextAction?: DoctorNextAction }
> = {
  auth_quota: {
    title: "Provider auth / quota",
    message: "The last turn failed on a credential or quota/billing error.",
    nextAction: { label: "Re-authenticate or check the provider's billing/quota" },
  },
  transport: {
    title: "Provider transport failure",
    message: "The last turn was interrupted by a transient provider transport error.",
    nextAction: { label: "Retry the turn; if it persists, check provider/internet status" },
  },
  malformed_protocol: {
    title: "Malformed provider protocol",
    message: "The model rendered raw tool-call markup as text instead of a typed tool call.",
    nextAction: { label: "Inspect provider diagnostics or switch models before retrying" },
  },
  unsafe_retry: {
    title: "Unsafe partial-stream retry",
    message:
      "A provider stream dropped after partial output, so the turn could not be auto-retried.",
    nextAction: { label: "Retry the turn manually; partial output was not replayed" },
  },
};

/** Rolls an area's findings into its header status (any error wins, then warn, then ok). */
function areaStatus(findings: readonly DoctorFinding[]): DoctorStatus {
  return rollupStatus(findings.map((f) => f.status));
}

function area(
  id: DoctorAreaId,
  label: string,
  verdict: string,
  findings: readonly DoctorFinding[],
  facts?: DoctorArea["facts"],
  // Most areas roll their status up from their findings; a binary area (e.g. internet) sets it
  // directly so it can carry warn/ok without a redundant finding row.
  statusOverride?: DoctorStatus,
): DoctorArea {
  return {
    id,
    label,
    status: statusOverride ?? areaStatus(findings),
    verdict,
    findings,
    ...(facts ? { facts } : {}),
  };
}

function coreArea(input: DoctorProbeInput): DoctorArea {
  const finding: DoctorFinding = {
    id: "core.process",
    status: input.host.live ? "ok" : "warn",
    title: "Host process",
    message: input.host.live ? `running as ${input.host.role}` : "connecting…",
  };
  return area(
    "core",
    "Core",
    finding.message,
    [finding],
    [
      { label: "instance", value: input.host.instanceId },
      { label: "role", value: input.host.role },
    ],
  );
}

function lastTurnCause(lastTurn: string | undefined): string | undefined {
  return lastTurn?.match(/^([a-z_]+):/)?.[1];
}

function lastTurnNextAction(cause: string | undefined): DoctorNextAction | undefined {
  switch (cause) {
    case "step_backstop":
      return { label: "Continue with a follow-up prompt or narrow the task" };
    case "context_pressure":
      return { label: "Let the synthesized answer finish, then compact or continue" };
    case "loop_stalled":
      return { label: "Inspect repeated tool calls and continue with a narrower instruction" };
    case "provider_protocol_anomaly":
      return { label: "Inspect provider diagnostics or switch models before retrying" };
    case "overflow":
      return { label: "Run /compact or reduce context before retrying" };
    default:
      return undefined;
  }
}

function sessionArea(input: DoctorProbeInput): DoctorArea {
  const { activeRun, queued, lastTurn, compacting } = input.session;
  const cause = lastTurnCause(lastTurn);
  const bad = lastTurn
    ? /error|overflow|noreply|interrupted|context_pressure|step_backstop|loop_stalled|provider_protocol_anomaly/i.test(
        lastTurn,
      )
    : false;
  const finding: DoctorFinding = {
    id: "session.run",
    status: bad ? "warn" : "ok",
    title: "Session / run",
    message: activeRun ? "a turn is running" : "idle",
    ...(bad && lastTurn ? { evidence: lastTurn } : {}),
    ...(bad ? { nextAction: lastTurnNextAction(cause) } : {}),
  };
  const facts: DoctorArea["facts"] = [
    { label: "active run", value: activeRun ?? "none" },
    { label: "queued", value: String(queued ?? 0) },
    ...(lastTurn
      ? [{ label: "last turn", value: lastTurn, status: bad ? ("warn" as const) : undefined }]
      : []),
    ...(compacting ? [{ label: "compacting", value: "yes" }] : []),
  ];
  return area("session", "Session / Run", finding.message, [finding], facts);
}

function providersArea(input: DoctorProbeInput): DoctorArea {
  const findings: DoctorFinding[] = input.providers.map((p) => ({
    id: `providers.${p.key}`,
    status: p.status === "unreachable" ? (p.kind === "local" ? "warn" : "error") : "ok",
    title: `${p.label} (${p.model})`,
    message:
      p.status === "unreachable"
        ? p.kind === "local"
          ? "runtime not reachable (start it to use this model)"
          : "unreachable"
        : p.status,
    ...(p.status === "unreachable" && p.kind === "local"
      ? { nextAction: { label: "Start the local runtime (LM Studio)" } }
      : {}),
  }));
  // Recent terminal provider-failure outcomes (D-076 M6) as two SEPARATE findings: retry exhaustion
  // (a transient outage Trevor auto-retried and still couldn't recover) is distinct from a
  // non-retryable terminal failure (auth/quota/rejected - never eligible for retry). Each is shown
  // only when it has happened, so a clean session adds neither.
  const pf = input.providerFailures;
  if (pf && pf.retryExhausted > 0) {
    findings.push({
      id: "providers.retryExhausted",
      status: "warn",
      title: "Provider retry exhaustion",
      message: `${pf.retryExhausted} turn${pf.retryExhausted === 1 ? "" : "s"} exhausted the auto-reconnect budget on a transient provider outage.`,
      ...(pf.lastRetryExhausted ? { evidence: pf.lastRetryExhausted } : {}),
      nextAction: { label: "Retry the turn; if it persists, check provider/internet status" },
    });
  }
  if (pf && pf.nonRetryableTerminal > 0) {
    findings.push({
      id: "providers.terminal",
      status: "warn",
      title: "Non-retryable provider failure",
      message: `${pf.nonRetryableTerminal} turn${pf.nonRetryableTerminal === 1 ? "" : "s"} ended with a terminal provider failure that was not eligible for retry.`,
      ...(pf.lastTerminal ? { evidence: pf.lastTerminal } : {}),
    });
  }
  // The LATEST incident per provider (D-007), categorized into the four actionable buckets
  // (auth/quota, transport, malformed protocol, unsafe retry). One finding per provider that has had
  // an incident; the sanitized upstream detail rides as collapsed evidence. Distinct from the COUNTS
  // above - this names what the last failure actually was and what to do about it.
  for (const incident of input.providerIncidents ?? []) {
    const category = INCIDENT_CATEGORY[incident.category];
    findings.push({
      id: `providers.incident.${incident.provider}`,
      status: "warn",
      title: `${category.title} - ${incident.provider}`,
      message: category.message,
      evidence: incident.detail,
      ...(category.nextAction ? { nextAction: category.nextAction } : {}),
    });
  }
  // D-065 catalog source auth/config state: surface the sources that need ACTION. The legacy roster
  // above lists only configured runnable providers, so a needs-auth / expired / rejected source would
  // otherwise be invisible in /doctor. Status + counts only - a key never enters a finding.
  const catalog = input.catalogSources ?? [];
  // One predicate drives BOTH the per-source findings and the "N ready / M need setup" overview, so
  // the count can never disagree with the findings shown.
  const needsSetup = (s: DoctorCatalogSource): boolean =>
    s.status === "error" || s.status === "needs-auth" || s.auth === "none" || s.auth === "expired";
  for (const s of catalog) {
    if (!needsSetup(s)) {
      continue;
    }
    const errored = s.status === "error";
    const expired = s.auth === "expired";
    const nextAction: DoctorNextAction =
      s.type === "oauth"
        ? { label: `Sign in to ${s.label}` }
        : s.type === "local"
          ? { label: `Start the ${s.label} runtime` }
          : { label: `Add the ${s.label} key to ~/.pi/auth.json` };
    findings.push({
      id: `providers.source.${s.sourceId}`,
      status: errored ? "error" : "warn",
      title: `${s.label} source`,
      message: errored
        ? "the configured key was rejected by the provider"
        : expired
          ? "the sign-in has expired - re-authenticate"
          : "not configured - no key or sign-in present",
      nextAction,
    });
  }

  const sourceCount = input.providers.length;
  const verdict = sourceCount
    ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}`
    : "no providers";

  const facts: DoctorFact[] = [];
  // A one-line catalog overview (D-065): how many sources are ready vs need setup, and the total live
  // model count across configured sources. Counts only - this is the source/catalog picture the
  // legacy roster can't give (it omits unconfigured sources entirely).
  if (catalog.length > 0) {
    const setupCount = catalog.filter(needsSetup).length;
    const ready = catalog.length - setupCount;
    const models = catalog.reduce((total, s) => total + s.modelCount, 0);
    facts.push({
      label: "catalog",
      value: `${catalog.length} source${catalog.length === 1 ? "" : "s"} (${ready} ready${setupCount ? `, ${setupCount} need setup` : ""}) · ${models} model${models === 1 ? "" : "s"}`,
    });
  }
  // Unclassified-failure observations (D-076 M6): a redacted diagnostic FACT (counts only), so it
  // informs without inflating the area severity - an unknown shape isn't a current health problem,
  // it's a breadcrumb for improving the classifier. Omitted entirely when nothing has been observed.
  const obs = input.observations;
  if (obs && obs.distinct > 0) {
    facts.push({
      label: "observations",
      value: `${obs.distinct} unclassified shape${obs.distinct === 1 ? "" : "s"} · ${obs.unknown} sighting${obs.unknown === 1 ? "" : "s"}`,
    });
  }
  return area(
    "providers",
    "Providers / Models / Auth",
    verdict,
    findings,
    facts.length > 0 ? facts : undefined,
  );
}

function internetArea(input: DoctorProbeInput): DoctorArea {
  const snap = input.internet;
  const status: DoctorStatus =
    snap.status === "online" ? "ok" : snap.status === "offline" ? "warn" : "not_checked";
  // Binary by design - just "am I online?". The verdict is one word; the probe mechanics (DNS+HTTPS,
  // the sanitized error) live as collapsed facts for debugging, not in the resting line, and there is
  // no redundant finding row repeating the verdict.
  const verdict =
    snap.status === "online" ? "online" : snap.status === "offline" ? "offline" : "not checked";
  const facts: DoctorArea["facts"] = [
    ...(snap.checkedAt ? [{ label: "checked", value: snap.checkedAt }] : []),
    ...(snap.status === "offline" && snap.error
      ? [{ label: "detail", value: snap.error, status: "warn" as const }]
      : []),
  ];
  return area("internet", "Internet", verdict, [], facts, status);
}

function toolsArea(input: DoctorProbeInput): DoctorArea {
  const finding: DoctorFinding = {
    id: "tools.core",
    status: input.tools.length > 0 ? "ok" : "warn",
    title: "Core tools",
    message: `${input.tools.length} tools available`,
  };
  return area(
    "tools",
    "Tools / Search",
    finding.message,
    [finding],
    [{ label: "tools", value: input.tools.join(", ") }],
  );
}

/** A root's status + display value: ownership, lifecycle (legacy), and writability drive the verdict. */
function rootFact(root: DoctorRootProbe): {
  readonly status: DoctorStatus;
  readonly value: string;
} {
  if (root.ownership === "external") {
    return { status: "ok", value: `${root.path} · external (read-only)` };
  }
  if (root.path === null) {
    return { status: "ok", value: "browser storage (ephemeral)" };
  }
  if (root.id === "legacy") {
    if (root.migrationAvailable) {
      return { status: "warn", value: `${root.path} · legacy data (importable)` };
    }
    return root.exists
      ? { status: "ok", value: `${root.path} · legacy data present` }
      : { status: "not_checked", value: `${root.path} · none` };
  }
  // A writable Trevor root (config/state/temp): not-created-yet and unwritable are the only problems.
  const base = !root.exists
    ? { status: "not_checked" as const, value: `${root.path} · not created yet` }
    : root.writable === false
      ? { status: "error" as const, value: `${root.path} · not writable` }
      : { status: "ok" as const, value: root.path };
  return root.overridden ? { ...base, value: `${base.value} · overridden` } : base;
}

/**
 * The Storage / Roots area (D-005): one fact per resolved root with its health, plus problem-only
 * findings (an unwritable Trevor root errors; importable ~/.trevor data warns with a migration hint).
 * External roots read as read-only and never warn; a not-yet-created root is `not_checked`, not an
 * error. The area status rolls up from the per-root fact statuses, and every path is already
 * home-abbreviated by the probe, so no raw home directory leaks into the diagnostics.
 */
function storageArea(input: DoctorProbeInput): DoctorArea {
  const roots = input.storage.roots;
  const facts: DoctorFact[] = roots.map((root) => {
    const { status, value } = rootFact(root);
    return { label: root.label, value, status };
  });

  const findings: DoctorFinding[] = [];
  for (const root of roots) {
    if (root.writable === false) {
      findings.push({
        id: `storage.${root.id}`,
        status: "error",
        title: `${root.label} not writable`,
        message: "Trevor cannot write this root.",
        source: root.path ?? undefined,
        nextAction: { label: "Check permissions on", command: root.path ?? undefined },
      });
    }
    if (root.id === "legacy" && root.migrationAvailable) {
      findings.push({
        id: "storage.legacy",
        status: "warn",
        title: "Legacy data",
        message: "Importable ~/.trevor data is present.",
        source: root.path ?? undefined,
        nextAction: {
          label: "Import ~/.trevor data via migration or set SESSION_STORE_DB / BLOB_STORE_DIR",
        },
      });
    }
  }

  const statusOverride = rollupStatus(facts.map((f) => f.status ?? "not_checked"));
  const verdict =
    statusOverride === "error"
      ? "A storage root needs attention."
      : statusOverride === "warn"
        ? "Legacy data is importable."
        : "All roots resolved and writable.";
  return area("storage", "Storage / Roots", verdict, findings, facts, statusOverride);
}

/** A cwd-lock finding for the Workspace area, only when the lock is contended or stale (both advisory
 *  warnings - a held or unlocked directory needs no finding, just the fact row). */
function cwdLockFinding(lock: CwdLockDoctorFact | undefined): DoctorFinding[] {
  if (!lock || !isCwdLockWarn(lock.state)) {
    return [];
  }
  return [
    {
      id: "workspace.cwd-lock",
      status: "warn",
      title: lock.state === "contended" ? "Cwd lock contended" : "Stale cwd lock",
      message:
        lock.state === "contended"
          ? "another live session owns this working directory"
          : "a leftover lock from a dead/abandoned owner (reclaimed on next acquire)",
      ...(lock.owner ? { source: lock.owner } : {}),
      nextAction: {
        label: `Inspect the owning host; ${CWD_LOCK_FORCE_CLEAR_HINT}`,
        ...(lock.path ? { command: lock.path } : {}),
      },
    },
  ];
}

function workspaceArea(input: DoctorProbeInput): DoctorArea {
  const lock = input.workspace.cwdLock;
  const finding: DoctorFinding = {
    id: "workspace.cwd",
    status: "ok",
    title: "Workspace",
    message: input.workspace.branch ? `on ${input.workspace.branch}` : "not a git repository",
    source: input.workspace.workspace,
  };
  const lockWarn = isCwdLockWarn(lock?.state);
  const facts: DoctorArea["facts"] = [
    { label: "cwd", value: input.workspace.cwd },
    ...(input.workspace.cwd !== input.workspace.workspace
      ? [{ label: "workspace", value: input.workspace.workspace }]
      : []),
    ...(input.workspace.branch ? [{ label: "branch", value: input.workspace.branch }] : []),
    ...(lock
      ? [
          {
            label: "cwd lock",
            value: cwdLockSummary(lock),
            ...(lockWarn ? { status: "warn" as const } : {}),
          },
        ]
      : []),
  ];
  return area("workspace", "Workspace", finding.message, [finding, ...cwdLockFinding(lock)], facts);
}

/** The local-model admission area (plan 11 M8): who holds each local runtime, how deep the queue is,
 *  the oldest wait, and a warn when a crashed holder still occupies a slot (a reclaim-on-next-acquire
 *  signal). Absent admission probe (no local work) reads as a clean "idle". */
function admissionArea(input: DoctorProbeInput): DoctorArea {
  const a = input.admission;
  if (!a || a.resources === 0) {
    const finding: DoctorFinding = {
      id: "admission.idle",
      status: "ok",
      title: "Local admission",
      message: "no local model in use",
    };
    return area("admission", "Local admission", finding.message, [finding]);
  }
  const stale = a.staleOwners > 0;
  const verdict =
    `${a.activeOwners} active, ${a.queued} queued` +
    (a.queued > 0 ? ` (oldest wait ${Math.round(a.oldestWaitMs / 1000)}s)` : "");
  const findings: DoctorFinding[] = [
    {
      id: "admission.summary",
      status: stale ? "warn" : "ok",
      title: "Local admission",
      message: verdict,
    },
    ...(stale
      ? [
          {
            id: "admission.stale",
            status: "warn" as const,
            title: "Stale local-model owner",
            message: `${a.staleOwners} active owner(s) have no live process; reclaimed on the next acquire`,
          },
        ]
      : []),
  ];
  const facts: DoctorArea["facts"] = [
    { label: "resources", value: String(a.resources) },
    { label: "active owners", value: String(a.activeOwners) },
    {
      label: "queued",
      value: String(a.queued),
      ...(a.queued > 0 ? { status: "warn" as const } : {}),
    },
    ...a.rows.map((row) => ({
      label: row.key,
      value:
        `${row.active}/${row.capacity} active, ${row.queued} queued` +
        (row.staleActive > 0 ? `, ${row.staleActive} stale` : ""),
      ...(row.staleActive > 0 ? { status: "warn" as const } : {}),
    })),
  ];
  return area("admission", "Local admission", verdict, findings, facts);
}

/**
 * The Updates / Version area (D-073): the package/build/version facts that ARE available (host build
 * version, runtime kind, Node version), plus an explicit note that this build does not query for a
 * newer release. A dev build with no embedded version reports the version finding as `not_checked`
 * (so it never implies up-to-date), while the Node/runtime facts always render.
 */
function updatesArea(input: DoctorProbeInput): DoctorArea {
  const b = input.build;
  const facts: DoctorArea["facts"] = [
    { label: "Trevor", value: b.version ?? "dev build", status: b.version ? "ok" : "not_checked" },
    { label: "Runtime", value: b.runtime },
    { label: "Node", value: b.node },
  ];
  const version: DoctorFinding = {
    id: "updates.version",
    status: b.version ? "ok" : "not_checked",
    title: "Version",
    message: b.version
      ? `Running Trevor ${b.version}.`
      : "No build version is embedded (a local dev build).",
  };
  // Update availability is deliberately NOT probed (it would need a network call /doctor does not
  // make), so the area is explicit that it has not checked for a newer release rather than implying
  // the build is current.
  const check: DoctorFinding = {
    id: "updates.check",
    status: "not_checked",
    title: "Update check",
    message: "Not checked - /doctor does not query for newer releases.",
  };
  return area("updates", "Updates / Version", version.message, [version, check], facts);
}

/** The docs-cache finding: ok when fresh, warn when stale (with a refresh action), else not_checked. */
function docsFinding(docs: DoctorWebDocs["docs"]): DoctorFinding {
  if (!docs.present) {
    return {
      id: "web.docs",
      status: "not_checked",
      title: "Docs cache",
      message: "No docs cache is present.",
    };
  }
  if (docs.stale) {
    return {
      id: "web.docs",
      status: "warn",
      title: "Docs cache",
      message: "The docs cache is stale.",
      nextAction: { label: "Refresh the docs cache" },
    };
  }
  return {
    id: "web.docs",
    status: "ok",
    title: "Docs cache",
    message: "The docs cache is present and fresh.",
  };
}

/**
 * The web_fetch backend-ladder finding (plan 04): static is always available, so the ladder is never
 * "unconfigured"; the message reports each backend's readiness (Jina available vs keyed, Firecrawl
 * configured vs unconfigured) and appends the sanitized last-backend error category when one has been
 * observed. Reads only enums + an error category, never a key value, so the area stays redaction-safe.
 */
function webFetchFinding(fetch: DoctorWebDocs["fetch"]): DoctorFinding {
  const jina = fetch.jina === "keyed" ? "Jina keyed" : "Jina available";
  const firecrawl =
    fetch.firecrawl === "configured" ? "Firecrawl configured" : "Firecrawl unconfigured";
  const ladder = `static, ${jina}, ${firecrawl}`;
  const message = fetch.lastError
    ? `Backend ladder ready (${ladder}). Last backend error: ${fetch.lastError}.`
    : `Backend ladder ready (${ladder}).`;
  return {
    id: "web.fetch",
    status: "ok",
    title: "Web fetch",
    message,
    ...(fetch.firecrawl === "unconfigured"
      ? { nextAction: { label: "Set FIRECRAWL_API_KEY to enable the rendered fallback" } }
      : {}),
  };
}

/**
 * Builds the Web / Docs area (D-073, plan 04) from {@link DoctorWebDocs} config facts: web-search key
 * presence, the web_fetch backend ladder's readiness, and docs-cache staleness. Redaction-safe by
 * construction - it reads only booleans/enums + a sanitized error category, never a key value. An
 * unconfigured web-search key is `not_checked` (not an error); the fetch ladder is always ready
 * (static needs no config); a stale docs cache warns.
 */
function webDocsArea(input: DoctorProbeInput): DoctorArea {
  const w = input.web;
  const findings: DoctorFinding[] = [
    w.searchConfigured
      ? {
          id: "web.search",
          status: "ok",
          title: "Web search",
          message: "A web-search provider key is configured.",
        }
      : {
          id: "web.search",
          status: "not_checked",
          title: "Web search",
          message: "No web-search provider key is configured.",
          nextAction: { label: "Set BRAVE_API_KEY or SERPER_API_KEY to enable web_search" },
        },
    webFetchFinding(w.fetch),
    docsFinding(w.docs),
  ];
  const statuses = findings.map((f) => f.status);
  const verdict = statuses.every((s) => s === "not_checked")
    ? "Web/docs tools are not configured."
    : statuses.includes("warn")
      ? "Some web/docs state needs attention."
      : "Web/docs tools are configured.";
  return area("web", "Web / Docs", verdict, findings);
}

/**
 * Builds a peripheral-subsystem area (MCP / LSP / Hooks, D-073) from its {@link PeripheralState}.
 * Maps each state to a status + verdict + next action: `unconfigured`/`timeout` stay `not_checked`
 * (nothing wrong / degraded, never a false error), `ready` is `ok`, `unavailable`/`auth-needed` warn
 * with a repair action, and `error` is an error with an inspect action. Pure, so the mapping is
 * unit-tested for every state.
 */
function peripheralArea(id: DoctorAreaId, label: string, state: PeripheralState): DoctorArea {
  let status: DoctorStatus;
  let message: string;
  let nextAction: DoctorNextAction | undefined;
  switch (state.kind) {
    case "unconfigured":
      status = "not_checked";
      message = `${label} is not configured.`;
      break;
    case "ready":
      status = "ok";
      message = state.detail;
      break;
    case "unavailable":
      status = "warn";
      message = state.detail ?? `${label} is configured but unavailable.`;
      nextAction = { label: `Check the ${label} integration` };
      break;
    case "auth-needed":
      status = "warn";
      message = state.detail ?? `${label} needs authentication.`;
      nextAction = { label: `Authenticate ${label}` };
      break;
    case "error":
      status = "error";
      message = state.detail ?? `${label} reported an error.`;
      nextAction = { label: `Inspect the ${label} integration` };
      break;
    case "timeout":
      status = "not_checked";
      message = state.detail ?? `${label} check timed out.`;
      nextAction = { label: "Re-run /doctor to retry" };
      break;
  }
  const finding: DoctorFinding = {
    id: `${id}.status`,
    status,
    title: label,
    message,
    ...(nextAction ? { nextAction } : {}),
  };
  return area(id, label, message, [finding]);
}

export function buildDoctorSnapshot(input: DoctorProbeInput): DoctorSnapshot {
  return {
    state: "ready",
    checkedAt: input.checkedAt,
    host: {
      workspace: input.workspace.workspace,
      instanceId: input.host.instanceId,
      role: input.host.role,
    },
    areas: [
      coreArea(input),
      sessionArea(input),
      providersArea(input),
      internetArea(input),
      toolsArea(input),
      webDocsArea(input),
      peripheralArea("mcp", "MCP", input.peripherals.mcp),
      peripheralArea("lsp", "LSP", input.peripherals.lsp),
      peripheralArea("hooks", "Hooks", input.peripherals.hooks),
      storageArea(input),
      workspaceArea(input),
      admissionArea(input),
      updatesArea(input),
    ],
  };
}
