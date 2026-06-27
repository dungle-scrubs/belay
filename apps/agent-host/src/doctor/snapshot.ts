import {
  type DoctorArea,
  type DoctorAreaId,
  type DoctorFinding,
  type DoctorNextAction,
  type DoctorSnapshot,
  type DoctorStatus,
  type InternetSnapshot,
  rollupStatus,
} from "@trevor/session";

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
  };
  readonly storage: { readonly home: string; readonly writable: boolean };
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
  readonly checkedAt: string;
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
 * Web / Docs dependency facts (D-073). Booleans + provider NAMES only - never key values - so the
 * area stays redaction-safe: whether a web-search key is configured, which fetch/rendering provider
 * (if any) is set, and the docs-cache presence/staleness.
 */
export interface DoctorWebDocs {
  readonly searchConfigured: boolean;
  /** The configured fetch/rendering provider name (e.g. "Jina"/"Firecrawl"), or null when none. */
  readonly fetchProvider: string | null;
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
  const sourceCount = input.providers.length;
  const verdict = sourceCount
    ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}`
    : "no providers";
  // Unclassified-failure observations (D-076 M6): a redacted diagnostic FACT (counts only), so it
  // informs without inflating the area severity - an unknown shape isn't a current health problem,
  // it's a breadcrumb for improving the classifier. Omitted entirely when nothing has been observed.
  const obs = input.observations;
  const facts: DoctorArea["facts"] =
    obs && obs.distinct > 0
      ? [
          {
            label: "observations",
            value: `${obs.distinct} unclassified shape${obs.distinct === 1 ? "" : "s"} · ${obs.unknown} sighting${obs.unknown === 1 ? "" : "s"}`,
          },
        ]
      : undefined;
  return area("providers", "Providers / Models / Auth", verdict, findings, facts);
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

function storageArea(input: DoctorProbeInput): DoctorArea {
  const finding: DoctorFinding = {
    id: "storage.home",
    status: input.storage.writable ? "ok" : "error",
    title: "TREVOR_HOME",
    message: input.storage.writable ? "writable" : "not writable",
    source: input.storage.home,
    ...(input.storage.writable
      ? {}
      : { nextAction: { label: "Check permissions on", command: input.storage.home } }),
  };
  return area("storage", "Storage / Roots", finding.message, [finding]);
}

function workspaceArea(input: DoctorProbeInput): DoctorArea {
  const finding: DoctorFinding = {
    id: "workspace.cwd",
    status: "ok",
    title: "Workspace",
    message: input.workspace.branch ? `on ${input.workspace.branch}` : "not a git repository",
    source: input.workspace.workspace,
  };
  const facts: DoctorArea["facts"] = [
    { label: "cwd", value: input.workspace.cwd },
    ...(input.workspace.cwd !== input.workspace.workspace
      ? [{ label: "workspace", value: input.workspace.workspace }]
      : []),
    ...(input.workspace.branch ? [{ label: "branch", value: input.workspace.branch }] : []),
  ];
  return area("workspace", "Workspace", finding.message, [finding], facts);
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
 * Builds the Web / Docs area (D-073) from {@link DoctorWebDocs} config facts: web-search key presence,
 * the fetch/rendering provider, and docs-cache staleness. Redaction-safe by construction - it reads
 * only booleans + a provider name, never a key value. An unconfigured dependency is `not_checked`
 * (not an error); a stale docs cache warns; any configured dependency lifts the area to ok.
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
    w.fetchProvider
      ? {
          id: "web.fetch",
          status: "ok",
          title: "Web fetch / rendering",
          message: `${w.fetchProvider} is configured for page fetch/rendering.`,
        }
      : {
          id: "web.fetch",
          status: "not_checked",
          title: "Web fetch / rendering",
          message: "No web fetch/rendering provider (Jina/Firecrawl) is configured.",
        },
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
      updatesArea(input),
    ],
  };
}
