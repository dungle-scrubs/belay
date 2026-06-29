import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import {
  type DoctorSnapshot,
  formatDoctorReport,
  type InternetSnapshot,
  RUNTIME_KIND,
  type SourceSummary,
  UNKNOWN_INTERNET,
} from "@trevor/session";
import { resolveTrevorStateHome } from "@trevor/session/node-paths";
import { Effect } from "effect";
import { fmtFields } from "../log";
import type { ProviderRegistry } from "../providers";
import { readObservations, summarizeObservations } from "../providers/observation-store";
import { providerFailures } from "../providers/provider-failure-log";
import { buildDoctorSnapshot, type DoctorProviderProbe } from "./snapshot";

/**
 * Builds the live `doctor.current` snapshot from already-resolved host facts (D-073). This is the
 * reusable boundary BOTH `/doctor` (the command, which gets these facts via CommandContext) and the
 * model-facing `doctor` tool (which gets them via the registered source in ./source) call, so the
 * two surfaces can never report a different health picture. The bounded, redacted probing is kept
 * explicit in {@link collectDoctorProbeResults}; the snapshot builder only combines runtime facts
 * with already-probed facts before delegating to {@link buildDoctorSnapshot}.
 */

/**
 * The live host facts the snapshot is assembled from - the narrow slice of runtime state /doctor
 * reads. Optionality mirrors CommandContext so the command can pass its context slice directly.
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
}

export interface DoctorCommandInput extends DoctorRuntimeFacts {
  readonly providers: ProviderRegistry;
}

export interface DoctorProbeResults {
  readonly providers: readonly DoctorProviderProbe[];
  readonly storageHome: string;
  readonly storageWritable: boolean;
  readonly tools: readonly string[];
  readonly observations: {
    readonly distinct: number;
    readonly unknown: number;
    readonly total: number;
  };
  readonly providerFailures: {
    readonly retryExhausted: number;
    readonly nonRetryableTerminal: number;
    readonly lastRetryExhausted?: string;
    readonly lastTerminal?: string;
  };
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
  lines.push(`host: ${input.instanceId} (${input.role})`);
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

/** Abbreviates the home dir to `~` for a sanitized /doctor path. */
function abbrevHome(absolute: string): string {
  const home = homedir();
  return absolute === home || absolute.startsWith(`${home}/`)
    ? `~${absolute.slice(home.length)}`
    : absolute;
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

/** Reads a string field off the host turn-machine record (the /doctor session facts). */
function hostStr(host: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = host?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Probes bounded live dependencies for /doctor without exposing raw provider/storage internals. */
export async function collectDoctorProbeResults(
  providers: ProviderRegistry,
): Promise<DoctorProbeResults> {
  const home = resolveTrevorStateHome();
  const [providerProbes, writable, observationStore, tools] = await Promise.all([
    Promise.all(
      Object.entries(providers).map(([key, provider]) => doctorProviderProbe(key, provider)),
    ),
    storageWritable(home),
    readObservations(),
    toolNames(),
  ]);
  const obs = summarizeObservations(observationStore);
  const summary = providerFailures.summary();
  return {
    providers: providerProbes,
    storageHome: home,
    storageWritable: writable,
    tools,
    observations: { distinct: obs.distinct, unknown: obs.unknown, total: obs.total },
    providerFailures: {
      retryExhausted: summary.retryExhausted,
      nonRetryableTerminal: summary.nonRetryableTerminal,
      lastRetryExhausted: summary.lastRetryExhausted?.detail,
      lastTerminal: summary.lastTerminal?.detail,
    },
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
    workspace: { cwd: facts.cwd, workspace: facts.workspace, branch: facts.branch },
    storage: { home: abbrevHome(probes.storageHome), writable: probes.storageWritable },
    // Package/build/version facts (D-073): the embedded version when present (else a dev build),
    // plus the always-available Node + runtime kind. Update-availability is not probed here.
    build: {
      version: process.env.npm_package_version ?? null,
      node: process.version,
      runtime: RUNTIME_KIND.host,
    },
    // MCP / LSP / Hooks are not integrated in this build, so each reports `unconfigured` (not an
    // error) - the area builder maps later states (unavailable/auth-needed/error/timeout) once a
    // real integration feeds them.
    peripherals: {
      mcp: { kind: "unconfigured" },
      lsp: { kind: "unconfigured" },
      hooks: { kind: "unconfigured" },
    },
    // Web / Docs config facts (D-073): presence booleans + a provider name only, never key values.
    // web_search reads BRAVE_API_KEY then SERPER_API_KEY; fetch/rendering would use Jina/Firecrawl.
    web: {
      searchConfigured: Boolean(process.env.BRAVE_API_KEY || process.env.SERPER_API_KEY),
      fetchProvider: process.env.JINA_API_KEY
        ? "Jina"
        : process.env.FIRECRAWL_API_KEY
          ? "Firecrawl"
          : null,
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
