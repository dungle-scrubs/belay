import { isResidencyResourceKey } from "@host/admission/contract";
import { admissionDoctorSummary } from "@host/admission/doctor";
import { type AdmissionCaps, snapshotAdmission } from "@host/admission/store";
import type { CompactionController } from "@host/agent/compaction-controller";
import {
  type BackgroundChildInfo,
  MAX_BACKGROUND_CHILDREN_PER_SESSION,
} from "@host/agent/delegate";
import type { TurnMachine } from "@host/agent/turn-machine";
import type { TurnScheduler } from "@host/agent/turn-scheduler";
import { abbrevHome, WORKSPACE_ROOT } from "@host/boot/paths";
import type { InternetMonitor } from "@host/connectivity/probe";
import type { HooksRuntime, HooksStatusSnapshot } from "@host/hooks/runtime";
import type { HookStatsEntry } from "@host/hooks/stats";
import type { LspServerStatus } from "@host/lsp/contract";
import type { LspManager } from "@host/lsp/manager";
import type { McpRuntime, McpServerStatusEntry } from "@host/mcp/runtime";
import { activeStylePref } from "@host/prefs/style-store";
import { discoverClaudeMigrations } from "@host/project-context/claude-migration";
import { loadPermanentlyIgnored } from "@host/project-context/claude-migration-ignores";
import {
  collectContextDiagnostics,
  formatContextDiagnostics,
} from "@host/project-context/context-diagnostics";
import { contextRegistry } from "@host/project-context/registry";
import type { CatalogSnapshot } from "@host/providers/catalog";
import type { HostResidency } from "@host/residency/host";
import {
  type CwdLockCaps,
  type CwdLockDoctorFact,
  cwdLockDoctorFact,
} from "@host/session/cwd-lock";
import type { Lease } from "@host/session/lease";
import { discoverAgents } from "@host/subagents/discovery";
import { commas } from "@host/transport/messages";
import { relativeTime, type WorktreeSummary } from "@trevor/session";
import { resolveTelemetryConfig, safeAttributes } from "@trevor/session/telemetry";
import type { DoctorRuntimeFacts } from "./build";
import { hooksAreaFindings, hooksDebugSummary, hooksPeripheralState } from "./hooks-status";
import { lspDebugSummary, lspPeripheralState, lspStoredDiagnostics } from "./lsp-status";
import { mcpDebugSummary, mcpPeripheralState } from "./mcp-status";
import type { TelemetryDoctorSummary } from "./probe-input";

/**
 * The live host facts /doctor reads (D-073), extracted from main.ts (plan 22.2 M2). main.ts
 * constructs {@link makeHostFacts} once with its live singletons (scheduler, turn machine, internet
 * monitor, catalog, lease, ...) so the `/doctor` command and the model-facing `doctor` tool draw
 * from the exact same state.
 *
 * Responsible for: reading live host runtime state into /doctor's DoctorRuntimeFacts.
 * Not for: probing/assembling the snapshot (build.ts) or the pure area/finding folds (the areas-* modules).
 */

/** The live main.ts state the facts are read from - constructed singletons and mutable-state getters. */
export interface HostFactsDeps {
  readonly scheduler: Pick<TurnScheduler, "debug">;
  readonly turnMachine: Pick<TurnMachine, "lastTermination">;
  readonly compactionController: Pick<CompactionController, "lastFold">;
  readonly internet: Pick<InternetMonitor, "current">;
  /** Whether replay has completed and the host is answering (main.ts's mutable `live` flag). */
  live(): boolean;
  /** The prompt projection's current length (main.ts's mutable `history`). */
  historyLength(): number;
  /** The active background subagents right now (D-048). */
  readonly backgroundChildren: ReadonlyMap<string, BackgroundChildInfo>;
  /** The managed worktrees for the host's current base repo (main.ts's guarded summaries read). */
  currentWorktrees(): readonly WorktreeSummary[];
  /** The host cwd's structured git status projection (main.ts's currentGit). */
  currentGit(): { readonly branch: string | undefined };
  /** The host-owned model source + catalog read model (main.ts's mutable `catalog`). */
  catalog(): CatalogSnapshot;
  readonly lease: Pick<Lease, "isLeader">;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly admissionCaps: AdmissionCaps;
  readonly residency: Pick<HostResidency, "summary">;
  /** The host telemetry sink's optional drop counter (file exporter only). */
  readonly hostTelemetry: { readonly stats?: () => { readonly dropped: number } };
  readonly cwdLockCaps: CwdLockCaps;
  /** The host MCP runtime (plan 23 M8): its status snapshot feeds the /doctor MCP area + debug. */
  readonly mcp: Pick<McpRuntime, "statusSnapshot">;
  /** The host LSP manager (plan 24 M8): its status snapshot feeds the /doctor LSP area + debug. */
  readonly lsp: Pick<LspManager, "statusSnapshot">;
  /** The host hooks runtime (plan 25 M9): its status + stats snapshots feed the /doctor Hooks
   *  area (state, approval/script/performance/legacy findings) and the debug line. */
  readonly hooks: Pick<HooksRuntime, "statusSnapshot" | "statsSnapshot">;
}

/** Builds the /doctor runtime-fact readers over the host's live state; main.ts wires it once. */
export function makeHostFacts(deps: HostFactsDeps) {
  const {
    scheduler,
    turnMachine,
    compactionController,
    internet,
    live,
    historyLength,
    backgroundChildren,
    currentWorktrees,
    currentGit,
    catalog,
    lease,
    instanceId,
    sessionId,
    admissionCaps,
    residency,
    hostTelemetry,
    cwdLockCaps,
    mcp,
    lsp,
    hooks,
  } = deps;

  /** A snapshot of the live turn machine for /doctor: what the host is doing right now.
   *  Takes the MCP/LSP status snapshots as arguments so one doctorFacts build snapshots each
   *  runtime exactly once (LSP snapshots can stat the filesystem for idle roots). */
  function hostState(
    mcpSnapshot: readonly McpServerStatusEntry[],
    lspSnapshot: readonly LspServerStatus[],
    hooksSnapshot: HooksStatusSnapshot,
    hooksStats: readonly HookStatsEntry[],
  ): Record<string, unknown> {
    const turns = scheduler.debug();
    return {
      live: live(),
      activeRun: turns.active,
      queued: turns.queued,
      history: historyLength(),
      lastAnswerSeq: turns.lastAnswerSeq,
      // Why the most recent turn ended (Phase 2 M4): answered | step_limit | overflow | noReply |
      // cancelled | interrupted | error. Omitted until the first turn completes.
      ...(turnMachine.lastTermination ? { lastTurn: turnMachine.lastTermination } : {}),
      compacting: turns.compacting,
      // Subagents (D-045..D-048): the discovered roster + the depth policy. Delegation is depth-1 (a
      // child is given no delegation capability); inline blocks, background fans out read-only (≤cap).
      subagents: `${discoverAgents().length} agents · depth≤1 · inline+background (≤${MAX_BACKGROUND_CHILDREN_PER_SESSION})`,
      // Active background subagents right now (D-048), so /doctor shows the live fan-out + the cap.
      ...(backgroundChildren.size > 0
        ? {
            background: `${backgroundChildren.size}/${MAX_BACKGROUND_CHILDREN_PER_SESSION} active: ${[
              ...backgroundChildren.values(),
            ]
              .map((c) => c.agent)
              .join(", ")}`,
          }
        : {}),
      ...(compactionController.lastFold
        ? {
            lastFold: `seq≤${compactionController.lastFold.throughSeq} ~${commas(compactionController.lastFold.tokensBefore)}→${commas(compactionController.lastFold.tokensAfter)}tok`,
          }
        : {}),
      // Ingested AGENTS.md context (D-080): how many files, from which scopes, bytes used vs dropped,
      // and whether anything was truncated - surfaced so a budget drop is never silent (unlike Codex).
      ...contextState(),
      // MCP runtime status (plan 23 M8): a compact per-status histogram of the configured servers,
      // absent when none are configured. Redaction-safe: server counts + status words only.
      ...mcpState(mcpSnapshot),
      // LSP manager status (plan 24 M8): a compact per-status histogram of the touched workspaces
      // plus stored diagnostic-error counts, absent when no adapter matches. Counts + status
      // words only - never a path, message, or env value.
      ...lspState(lspSnapshot),
      // Hooks runtime status (plan 25 M9): a compact trust histogram of the configured hooks
      // plus total runs, absent when nothing is configured. Keys + status words only.
      ...hooksState(hooksSnapshot, hooksStats),
      // Managed worktrees (D-091): the current row + count, plus any stale (missing-path) entries, so
      // a worktree/session mismatch is visible at a glance.
      ...worktreeState(),
      // Public-internet reachability (D-060): the advisory status + last-probe age/error, distinct
      // from provider health and session-store presence.
      internet: internetState(),
    };
  }

  /** A compact internet-status line for /doctor (status + checking + last-probe age + sanitized error). */
  function internetState(): string {
    const snap = internet.current();
    // Same formatter the web's internet-status uses on this snapshot's checkedAt, so /doctor and the
    // browser can't drift on the probe-age label.
    const age = snap.checkedAt !== null ? ` ${relativeTime(snap.checkedAt, Date.now())}` : "";
    const checking = snap.checking ? " · checking…" : "";
    const error = snap.status !== "online" && snap.error ? ` · ${snap.error}` : "";
    return `${snap.status}${age}${checking} · probe ${snap.targetClass}${error}`;
  }

  /** The compact MCP debug line for /doctor's host record; nothing when unconfigured. */
  function mcpState(snapshot: readonly McpServerStatusEntry[]): Record<string, string> {
    const summary = mcpDebugSummary(snapshot);
    return summary ? { mcp: summary } : {};
  }

  /** The compact LSP debug line for /doctor's host record; nothing when no adapter matches. */
  function lspState(snapshot: readonly LspServerStatus[]): Record<string, string> {
    const summary = lspDebugSummary(snapshot);
    return summary ? { lsp: summary } : {};
  }

  /** The compact hooks debug line for /doctor's host record; nothing when unconfigured. */
  function hooksState(
    snapshot: HooksStatusSnapshot,
    stats: readonly HookStatsEntry[],
  ): Record<string, string> {
    const summary = hooksDebugSummary(snapshot, stats);
    return summary ? { hooks: summary } : {};
  }

  /** The managed-worktree summary for /doctor: the current row, the managed count, and stale entries. */
  function worktreeState(): Record<string, string> {
    const rows = currentWorktrees();
    const managed = rows.filter((w) => !w.baseline);
    if (managed.length === 0) {
      return {};
    }
    const current = rows.find((w) => w.current);
    const stale = managed.filter((w) => w.missing).length;
    return {
      worktrees: `${managed.length} managed · on ${current?.branch ?? "?"}${
        stale > 0 ? ` · ${stale} stale` : ""
      }`,
    };
  }

  /**
   * The project-context summary for /doctor (D-012): AGENTS.md vs `.trevor/rules` (with inclusion
   * reasons), bytes used/dropped, plus a `claudeMd` line distinguishing detected CLAUDE.md files,
   * converted pointers, still-to-migrate (required-response), and ignored ones. Count-only - no rule or
   * instruction body is ever dumped. The migration inventory is a bounded workspace walk done on demand
   * (a /doctor build), not per turn.
   */
  function contextState(): Record<string, string> {
    const cwd = process.cwd();
    return formatContextDiagnostics(
      collectContextDiagnostics(
        contextRegistry.report(),
        discoverClaudeMigrations(cwd),
        loadPermanentlyIgnored(cwd),
      ),
    );
  }

  /**
   * The live host facts /doctor reads (D-073). Assembled once here from the host's singletons so the
   * `/doctor` command (via CommandContext) and the model-facing `doctor` tool (via the snapshot
   * source main.ts registers) draw from the exact same state.
   */
  function doctorFacts(): DoctorRuntimeFacts {
    const cwdLock = workspaceCwdLockFact();
    const style = activeStylePref();
    // One snapshot per runtime per build: hostState's debug lines and the peripheral rollups
    // below fold the SAME reads instead of re-snapshotting (LSP snapshots can stat the fs,
    // hooks snapshots recompute trust fingerprints).
    const mcpSnapshot = mcp.statusSnapshot();
    const lspSnapshot = lsp.statusSnapshot();
    const hooksSnapshot = hooks.statusSnapshot();
    const hooksStats = hooks.statsSnapshot();
    return {
      cwd: abbrevHome(process.cwd()),
      workspace: abbrevHome(WORKSPACE_ROOT),
      instanceId: instanceId.slice(0, 8),
      role: lease.isLeader() ? "leader" : "standby",
      host: hostState(mcpSnapshot, lspSnapshot, hooksSnapshot, hooksStats),
      internet: internet.current(),
      branch: currentGit().branch,
      catalog: catalog().sources,
      activeStyle: { id: style.activeStyle, source: style.source },
      ...(cwdLock ? { cwdLock } : {}),
      // Residency claims share the admission store, so exclude them from the admission summary (they have
      // their own `residency` projection) - otherwise a resident model would double-count as a lease holder.
      admission: admissionDoctorSummary(
        snapshotAdmission(admissionCaps).filter((v) => !isResidencyResourceKey(v.key)),
        Date.now(),
      ),
      residency: residency.summary(),
      telemetry: telemetryDoctorFacts(),
      // The MCP runtime rollup (plan 23 M8, D-009): per-server status folded into the one
      // peripheral state the doctor MCP area renders; every field is already redacted.
      mcp: mcpPeripheralState(mcpSnapshot, Date.now()),
      // The LSP manager rollup (plan 24 M8, D-008): per-workspace status folded into the one
      // peripheral state the doctor LSP area renders (details scrubbed + bounded by the fold),
      // plus stored diagnostic counts for the diagnostic-warning finding.
      ...lspFacts(lspSnapshot),
      // The hooks runtime rollup (plan 25 M9, D-009): configured hooks + trust states folded
      // into the Hooks peripheral state, plus the approval/script/performance/legacy findings.
      hooks: hooksPeripheralState(hooksSnapshot),
      hooksFindings: hooksAreaFindings(hooksSnapshot, hooksStats),
    };
  }

  /** The /doctor LSP facts: the folded peripheral state plus stored-diagnostics counts. */
  function lspFacts(
    snapshot: readonly LspServerStatus[],
  ): Pick<DoctorRuntimeFacts, "lsp" | "lspDiagnostics"> {
    const diagnostics = lspStoredDiagnostics(snapshot);
    return {
      lsp: lspPeripheralState(snapshot, Date.now()),
      ...(diagnostics ? { lspDiagnostics: diagnostics } : {}),
    };
  }

  /** The telemetry mode + exporter health for /doctor (plan 13 M7). Derived from the resolved config + the
   *  host sink's drop count + a live redaction self-test; never exposes a DSN, endpoint, prompt, or path. */
  function telemetryDoctorFacts(): TelemetryDoctorSummary {
    const config = resolveTelemetryConfig();
    // Redaction self-test: a known-sensitive probe key MUST be dropped and a benign one kept.
    const probe = safeAttributes({ prompt: "secret-probe", ok: 1 });
    const redactionOk = !("prompt" in probe) && probe.ok === 1;
    return {
      exporter: config.otelExporter,
      remoteEnabled: config.remoteEnabled,
      sentryConfigured: config.sentryDsn !== null,
      providerTrace: config.providerTrace,
      suppressed: config.suppressedReason,
      drops: hostTelemetry.stats?.().dropped ?? 0,
      redactionOk,
    };
  }

  /** The cwd advisory-lock state for /doctor (plan 01), with the lock-file path home-abbreviated.
   *  Best-effort: a probe failure just omits the fact rather than breaking the health report. */
  function workspaceCwdLockFact(): CwdLockDoctorFact | undefined {
    try {
      const fact = cwdLockDoctorFact(WORKSPACE_ROOT, sessionId, cwdLockCaps);
      return { ...fact, path: abbrevHome(fact.path) };
    } catch {
      return undefined;
    }
  }

  return { doctorFacts };
}
