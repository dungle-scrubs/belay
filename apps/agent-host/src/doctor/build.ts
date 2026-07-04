import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { abbrevHome } from "@host/boot/paths";
import { type CwdLockDoctorFact, cwdLockSummary } from "@host/session/cwd-lock";
import { fmtFields } from "@host/transport/log";
import {
  type DoctorFinding,
  type DoctorSnapshot,
  formatDoctorReport,
  type InternetSnapshot,
  RUNTIME_KIND,
  type SourceSummary,
  UNKNOWN_INTERNET,
} from "@trevor/session";
import { nodeMigrationFs, planLegacyMigration } from "@trevor/session/legacy-migration";
import { type RootCategory, resolveRootPolicy } from "@trevor/session/node-paths";
import { Effect } from "effect";
import type { AdmissionDoctorSummary } from "../admission/doctor";
import type { ProviderRegistry } from "../providers";
import { readObservations, summarizeObservations } from "../providers/observation-store";
import { providerFailures } from "../providers/provider-failure-log";
import { incidentCategory, providerIncidents } from "../providers/provider-incidents";
import type { ResidencyDoctorSummary } from "../residency/doctor";
import { lastWebFetchError } from "../tools/web-fetch/web-fetch-log";
import type {
  DoctorLspDiagnostics,
  DoctorProviderIncident,
  DoctorProviderProbe,
  DoctorRootProbe,
  PeripheralState,
  TelemetryDoctorSummary,
} from "./probe-input";
import { buildDoctorSnapshot } from "./snapshot";

/**
 * Builds the live `doctor.current` snapshot from already-resolved host facts (D-073). This is the
 * reusable boundary BOTH `/doctor` (the command, which gets these facts via CommandContext) and the
 * model-facing `doctor` tool (which gets them via the registered source in ./source) call, so the
 * two surfaces can never report a different health picture. The bounded, redacted probing is kept
 * explicit in {@link collectDoctorProbeResults}; the snapshot builder only combines runtime facts
 * with already-probed facts before delegating to {@link buildDoctorSnapshot}.
 *
 * Responsible for: probing live host facts and assembling the /doctor snapshot + command result.
 * Not for: the pure area/finding folds (snapshot.ts + the areas-* modules) or the tool registration seam (source.ts).
 */

/**
 * The live host facts the snapshot is assembled from - the opaque runtime fact bag /doctor reads.
 * `cwd`/`workspace` are already abbreviated by the caller; `host` is the live turn-machine record
 * the session facts (active run, queue, last termination) are read off.
 */
export interface DoctorRuntimeFacts {
  readonly cwd: string;
  readonly workspace: string;
  readonly instanceId: string;
  readonly role: string;
  readonly internet?: InternetSnapshot;
  readonly branch?: string;
  readonly lease?: Record<string, unknown>;
  readonly host?: Record<string, unknown>;
  /** D-065 catalog source summaries (auth/config + model counts), surfaced in the Providers area. */
  readonly catalog?: readonly SourceSummary[];
  /** Cwd advisory-lock state for this host's working directory (plan 01), surfaced in the Workspace area. */
  readonly cwdLock?: CwdLockDoctorFact;
  /** The active output style (plan 03) - run attribution: which style shapes this session's answers. */
  readonly activeStyle?: { readonly id: string; readonly source: string };
  /** Local-model admission state (plan 11), surfaced in the Local admission area. */
  readonly admission?: AdmissionDoctorSummary;
  /** Local-model residency state (plan 11.1), folded into the Local admission area. */
  readonly residency?: ResidencyDoctorSummary;
  /** Telemetry mode + exporter health (plan 13 M7), surfaced in the Telemetry area. */
  readonly telemetry?: TelemetryDoctorSummary;
  /** The MCP runtime rollup (plan 23 M8, D-009): the runtime's per-server status snapshot folded
   *  by doctor/mcp-status into one peripheral state. Absent (not probed) means unconfigured. */
  readonly mcp?: PeripheralState;
  /** The LSP manager rollup (plan 24 M8, D-008): the manager's status snapshot folded by
   *  doctor/lsp-status into one peripheral state. Absent (not probed) means unconfigured. */
  readonly lsp?: PeripheralState;
  /** Stored LSP diagnostics counts (plan 24 M8): errors surface as the LSP area's
   *  diagnostic-warning finding. Counts only, never a message or a path. */
  readonly lspDiagnostics?: DoctorLspDiagnostics;
  /** The hooks runtime rollup (plan 25 M9, D-009): the runtime's status snapshot folded by
   *  doctor/hooks-status into one peripheral state. Absent (not probed) means unconfigured. */
  readonly hooks?: PeripheralState;
  /** The Hooks area's extra findings (plan 25 M9): approval, missing scripts, degrading
   *  handlers, config issues, and legacy HOOK.md migration guidance. */
  readonly hooksFindings?: readonly DoctorFinding[];
}

export interface DoctorCommandInput extends DoctorRuntimeFacts {
  readonly providers: ProviderRegistry;
}

export interface DoctorProbeResults {
  readonly providers: readonly DoctorProviderProbe[];
  readonly roots: readonly DoctorRootProbe[];
  readonly tools: readonly string[];
  readonly observations: {
    readonly distinct: number;
    readonly unknown: number;
    readonly total: number;
    readonly top: readonly { readonly fingerprint: string; readonly count: number }[];
  };
  readonly providerFailures: {
    readonly retryExhausted: number;
    readonly nonRetryableTerminal: number;
    readonly lastRetryExhausted?: string;
    readonly lastTerminal?: string;
  };
  readonly providerIncidents: readonly DoctorProviderIncident[];
}

export interface DoctorSnapshotInput {
  readonly runtime: DoctorRuntimeFacts;
  readonly probes: DoctorProbeResults;
  readonly checkedAt?: string;
}

type DoctorView = "summary" | "full" | "json" | "text";

interface DoctorCommand {
  readonly view: DoctorView;
  readonly refresh: boolean;
  readonly copy: boolean;
}

/** Token -> view aliases (so `detail`/`details` mean `full`, `plain` means `text`). */
const VIEW_TOKENS: Readonly<Record<string, DoctorView>> = {
  summary: "summary",
  full: "full",
  detail: "full",
  details: "full",
  json: "json",
  text: "text",
  plain: "text",
};

/** Parses a `/doctor` arg string leniently: unknown tokens are ignored and the last view wins. */
function parseDoctorCommand(args: string): DoctorCommand {
  const tokens = args.toLowerCase().split(/\s+/).filter(Boolean);
  let view: DoctorView = "summary";
  let refresh = false;
  let copy = false;
  for (const token of tokens) {
    if (token === "refresh" || token === "recheck") {
      refresh = true;
      continue;
    }
    if (token === "copy") {
      copy = true;
      continue;
    }
    const mapped = VIEW_TOKENS[token];
    if (mapped) {
      view = mapped;
    }
  }
  return { view, refresh, copy };
}

/**
 * One probe of a provider's reachability: run `readiness()` once and map it - and any throw - to the
 * warm/cold/unreachable vocabulary both /doctor surfaces render. The single owner of the
 * readiness -> status ladder + the unreachable-on-throw policy, so the structured probe and the
 * plaintext line can't drift on what "warm" means.
 */
async function probeProviderStatus(
  provider: ProviderRegistry[string],
): Promise<DoctorProviderProbe["status"]> {
  try {
    const { ready, warm } = await Effect.runPromise(provider.readiness());
    return ready ? (warm ? "warm" : "cold") : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** Structured provider reachability for the snapshot (warm/cold/unreachable + kind), defensively probed. */
async function doctorProviderProbe(
  key: string,
  provider: ProviderRegistry[string],
): Promise<DoctorProviderProbe> {
  const status = await probeProviderStatus(provider);
  return { key, label: provider.label, model: provider.model, kind: provider.kind, status };
}

/** One provider's reachability/warmth line for the legacy plaintext /doctor dump. */
async function providerStatus(key: string, provider: ProviderRegistry[string]): Promise<string> {
  const status = await probeProviderStatus(provider);
  // Adapters that expose inspectable state (e.g. LM Studio's served context / last load
  // error) get an indented detail line; cloud providers with nothing to add stay terse.
  const info = provider.debugInfo?.();
  const detail = info ? `\n      ${fmtFields(info)}` : "";
  return `  ${key} - ${provider.label} (${provider.model}) - ${status}${detail}`;
}

async function toolNames(): Promise<string[]> {
  const tools = await import("../tools");
  return tools.TOOL_DEFS.map((t) => t.name);
}

/** The legacy plaintext /doctor dump (`/doctor text`), kept for terminals / no-dashboard clients. */
async function doctorText(input: DoctorCommandInput): Promise<string> {
  const lines: string[] = [`workspace: ${input.workspace}`];
  if (input.cwd !== input.workspace) {
    lines.push(`cwd: ${input.cwd}`);
  }
  if (input.cwdLock) {
    lines.push(`cwd lock: ${cwdLockSummary(input.cwdLock)}`);
  }
  lines.push(`host: ${input.instanceId} (${input.role})`);
  if (input.activeStyle) {
    lines.push(`style: ${input.activeStyle.id} (${input.activeStyle.source})`);
  }
  if (input.host) {
    lines.push(`turn: ${fmtFields(input.host)}`);
  }
  if (input.lease) {
    lines.push(`lease: ${fmtFields(input.lease)}`);
  }
  lines.push("", "providers:");
  const statuses = await Promise.all(
    Object.entries(input.providers).map(([key, provider]) => providerStatus(key, provider)),
  );
  lines.push(...statuses, "", `tools: ${(await toolNames()).join(", ")}`);
  return lines.join("\n");
}

/** Whether a directory is writable (a bounded fs probe for the /doctor Storage area). */
async function storageWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes one policy root for the Storage/Roots area: its sanitized path, existence, and (for a
 * writable Trevor root that exists) writability. Writability is `null` where it does not apply
 * (external/legacy roots, the browser store, or a root that does not exist yet); the legacy root
 * additionally reports whether importable ~/.trevor data is present via the migration planner.
 */
async function probeRoot(category: RootCategory): Promise<DoctorRootProbe> {
  const path = category.path === null ? null : abbrevHome(category.path);
  const exists = category.path !== null && existsSync(category.path);
  const writable =
    category.writable && category.path !== null && exists
      ? await storageWritable(category.path)
      : null;
  const overridden = category.envOverride ? Boolean(process.env[category.envOverride]) : false;
  const migrationAvailable =
    category.id === "legacy" ? planLegacyMigration(nodeMigrationFs).willMigrate : false;
  return {
    id: category.id,
    label: category.label,
    ownership: category.ownership,
    path,
    exists,
    writable,
    overridden,
    migrationAvailable,
  };
}

/** Reads a string field off the host turn-machine record (the /doctor session facts). */
function hostStr(host: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = host?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Probes bounded live dependencies for /doctor without exposing raw provider/storage internals. */
export async function collectDoctorProbeResults(
  providers: ProviderRegistry,
): Promise<DoctorProbeResults> {
  const [providerProbes, roots, observationStore, tools] = await Promise.all([
    Promise.all(
      Object.entries(providers).map(([key, provider]) => doctorProviderProbe(key, provider)),
    ),
    Promise.all(resolveRootPolicy().map(probeRoot)),
    readObservations(),
    toolNames(),
  ]);
  const obs = summarizeObservations(observationStore);
  const summary = providerFailures.summary();
  // Project the latest incident per provider into the redaction-safe doctor shape: the typed reason,
  // its actionable category, and the already-sanitized detail - never the raw diagnostic partials,
  // status, or request id (those stay in the structured log, not the user-facing finding).
  const incidents: DoctorProviderIncident[] = providerIncidents
    .latestByProvider()
    .map((incident) => ({
      provider: incident.diagnostic.provider,
      ...(incident.diagnostic.model ? { model: incident.diagnostic.model } : {}),
      category: incidentCategory(incident.diagnostic),
      reason: incident.diagnostic.reason,
      detail: incident.diagnostic.detail,
      attempt: incident.diagnostic.attempt,
      at: incident.at,
    }));
  return {
    providers: providerProbes,
    roots,
    tools,
    observations: { distinct: obs.distinct, unknown: obs.unknown, total: obs.total, top: obs.top },
    providerFailures: {
      retryExhausted: summary.retryExhausted,
      nonRetryableTerminal: summary.nonRetryableTerminal,
      lastRetryExhausted: summary.lastRetryExhausted?.detail,
      lastTerminal: summary.lastTerminal?.detail,
    },
    providerIncidents: incidents,
  };
}

/** Assembles the current host-health snapshot from runtime facts plus already-probed facts. */
export function buildLiveDoctorSnapshot(input: DoctorSnapshotInput): DoctorSnapshot {
  const { runtime: facts, probes } = input;
  return buildDoctorSnapshot({
    host: { instanceId: facts.instanceId, role: facts.role, live: facts.role !== "standby" },
    session: {
      activeRun: hostStr(facts.host, "activeRun"),
      queued: typeof facts.host?.queued === "number" ? facts.host.queued : 0,
      lastTurn: hostStr(facts.host, "lastTurn"),
      compacting: facts.host?.compacting === true,
    },
    providers: probes.providers,
    internet: facts.internet ?? UNKNOWN_INTERNET,
    tools: probes.tools,
    workspace: {
      cwd: facts.cwd,
      workspace: facts.workspace,
      branch: facts.branch,
      ...(facts.cwdLock ? { cwdLock: facts.cwdLock } : {}),
    },
    storage: { roots: probes.roots },
    ...(facts.admission ? { admission: facts.admission } : {}),
    ...(facts.residency ? { residency: facts.residency } : {}),
    ...(facts.telemetry ? { telemetry: facts.telemetry } : {}),
    // Package/build/version facts (D-073): the embedded version when present (else a dev build),
    // plus the always-available Node + runtime kind. Update-availability is not probed here.
    build: {
      version: process.env.npm_package_version ?? null,
      node: process.version,
      runtime: RUNTIME_KIND.host,
    },
    // MCP, LSP, and Hooks report their subsystems' REAL rollups (plans 23/24 M8, 25 M9) fed in
    // by host-facts; an unprobed subsystem reports `unconfigured` (not an error).
    peripherals: {
      mcp: facts.mcp ?? { kind: "unconfigured" },
      lsp: facts.lsp ?? { kind: "unconfigured" },
      hooks: facts.hooks ?? { kind: "unconfigured" },
    },
    // Stored LSP diagnostics counts (plan 24 M8): with errors present, the LSP area attaches
    // its diagnostic-warning finding (D-008).
    ...(facts.lspDiagnostics ? { lspDiagnostics: facts.lspDiagnostics } : {}),
    // The Hooks area's extra findings (plan 25 M9): approval / scripts / performance / config /
    // legacy-migration warnings ride beside the lifecycle state, like the LSP diagnostics.
    ...(facts.hooksFindings ? { hooksFindings: facts.hooksFindings } : {}),
    // Web / Docs config facts (D-073, plan 04): presence booleans + readiness enums only, never key
    // values. web_search reads BRAVE_API_KEY then SERPER_API_KEY; the web_fetch ladder is static
    // (always), Jina (keyless, "keyed" when JINA_API_KEY is set), and Firecrawl (gated on
    // FIRECRAWL_API_KEY). The last sanitized backend error is read from the tool path's log module.
    web: {
      searchConfigured: Boolean(process.env.BRAVE_API_KEY || process.env.SERPER_API_KEY),
      fetch: {
        staticAvailable: true,
        jina: process.env.JINA_API_KEY ? "keyed" : "available",
        firecrawl: process.env.FIRECRAWL_API_KEY ? "configured" : "unconfigured",
        ...(lastWebFetchError() ? { lastError: lastWebFetchError() } : {}),
      },
      docs: { present: false, stale: false },
    },
    // Redacted provider-failure observation counts (D-076 M6): how many distinct unclassified shapes
    // the classifier has logged, surfaced as a Providers fact (counts only, no secrets).
    observations: probes.observations,
    // Recent terminal provider-failure outcomes (D-076 M6): retry-exhausted vs non-retryable,
    // surfaced as two distinct Providers findings. Sanitized one-line details only.
    providerFailures: {
      retryExhausted: probes.providerFailures.retryExhausted,
      nonRetryableTerminal: probes.providerFailures.nonRetryableTerminal,
      lastRetryExhausted: probes.providerFailures.lastRetryExhausted,
      lastTerminal: probes.providerFailures.lastTerminal,
    },
    providerIncidents: probes.providerIncidents,
    // D-065 catalog sources: a redaction-safe projection (status/auth/counts only) so /doctor can
    // explain provider auth/setup state and the live model picture without exposing any key.
    catalogSources: (facts.catalog ?? []).map((s) => ({
      sourceId: s.sourceId,
      label: s.label,
      type: s.type,
      status: s.status,
      auth: s.auth,
      modelCount: s.modelCount,
    })),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  });
}

/** Formats an already-built doctor snapshot for model-facing diagnostics. */
export function formatDoctorSnapshot(snapshot: DoctorSnapshot): string {
  return formatDoctorReport(snapshot);
}

/** Builds the command result for `/doctor`, including private arg parsing and view selection. */
export async function buildDoctorCommandResult(
  args: string,
  input: DoctorCommandInput,
): Promise<string> {
  const command = parseDoctorCommand(args);
  if (command.view === "text") {
    return doctorText(input);
  }
  const probes = await collectDoctorProbeResults(input.providers);
  return JSON.stringify(buildLiveDoctorSnapshot({ runtime: input, probes }));
}
