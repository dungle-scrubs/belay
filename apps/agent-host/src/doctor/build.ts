import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import {
  type DoctorSnapshot,
  type InternetSnapshot,
  RUNTIME_KIND,
  type SourceSummary,
  UNKNOWN_INTERNET,
} from "@trevor/session";
import { resolveTrevorStateHome } from "@trevor/session/node-paths";
import { Effect } from "effect";
import type { ProviderRegistry } from "../providers";
import { readObservations, summarizeObservations } from "../providers/observation-store";
import { providerFailures } from "../providers/provider-failure-log";
import { TOOL_DEFS } from "../tools";
import { buildDoctorSnapshot, type DoctorProviderProbe } from "./snapshot";

/**
 * Builds the live `doctor.current` snapshot from already-resolved host facts (D-073). This is the
 * single reusable accessor BOTH `/doctor` (the command, which gets these facts via CommandContext)
 * and the model-facing `doctor` tool (which gets them via the registered source in ./source) call,
 * so the two surfaces can never report a different health picture. It owns the bounded, redacted
 * probing (provider readiness, storage writeability, observation/failure summaries); the pure
 * area/finding construction stays in {@link buildDoctorSnapshot}.
 */

/**
 * The live host facts the snapshot is assembled from - the narrow slice of runtime state /doctor
 * reads. Optionality mirrors CommandContext so the command can pass its context slice directly.
 * `cwd`/`workspace` are already abbreviated by the caller; `host` is the live turn-machine record
 * the session facts (active run, queue, last termination) are read off.
 */
export interface DoctorFacts {
  readonly providers: ProviderRegistry;
  readonly cwd: string;
  readonly workspace: string;
  readonly instanceId: string;
  readonly role: string;
  readonly internet?: InternetSnapshot;
  readonly branch?: string;
  readonly host?: Record<string, unknown>;
  /** D-065 catalog source summaries (auth/config + model counts), surfaced in the Providers area. */
  readonly catalog?: readonly SourceSummary[];
}

/** Structured provider reachability for the snapshot (warm/cold/unreachable + kind), defensively probed. */
async function doctorProviderProbe(
  key: string,
  provider: ProviderRegistry[string],
): Promise<DoctorProviderProbe> {
  let status: DoctorProviderProbe["status"];
  try {
    const { ready, warm } = await Effect.runPromise(provider.readiness());
    status = ready ? (warm ? "warm" : "cold") : "unreachable";
  } catch {
    status = "unreachable";
  }
  return { key, label: provider.label, model: provider.model, kind: provider.kind, status };
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

/** Assembles the current host-health snapshot: probes the bounded live facts, then builds the areas. */
export async function buildLiveDoctorSnapshot(facts: DoctorFacts): Promise<DoctorSnapshot> {
  const home = resolveTrevorStateHome();
  const [providers, writable, observationStore] = await Promise.all([
    Promise.all(
      Object.entries(facts.providers).map(([key, provider]) => doctorProviderProbe(key, provider)),
    ),
    storageWritable(home),
    readObservations(),
  ]);
  const obs = summarizeObservations(observationStore);
  const summary = providerFailures.summary();
  return buildDoctorSnapshot({
    host: { instanceId: facts.instanceId, role: facts.role, live: facts.role !== "standby" },
    session: {
      activeRun: hostStr(facts.host, "activeRun"),
      queued: typeof facts.host?.queued === "number" ? facts.host.queued : 0,
      lastTurn: hostStr(facts.host, "lastTurn"),
      compacting: facts.host?.compacting === true,
    },
    providers,
    internet: facts.internet ?? UNKNOWN_INTERNET,
    tools: TOOL_DEFS.map((t) => t.name),
    workspace: { cwd: facts.cwd, workspace: facts.workspace, branch: facts.branch },
    storage: { home: abbrevHome(home), writable },
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
    observations: { distinct: obs.distinct, unknown: obs.unknown, total: obs.total },
    // Recent terminal provider-failure outcomes (D-076 M6): retry-exhausted vs non-retryable,
    // surfaced as two distinct Providers findings. Sanitized one-line details only.
    providerFailures: {
      retryExhausted: summary.retryExhausted,
      nonRetryableTerminal: summary.nonRetryableTerminal,
      lastRetryExhausted: summary.lastRetryExhausted?.detail,
      lastTerminal: summary.lastTerminal?.detail,
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
    checkedAt: new Date().toISOString(),
  });
}
