import { execFile, execSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { leaseOptions, makeLeadership } from "@host/boot/leadership";
import { abbrevHome, WORKSPACE_ROOT } from "@host/boot/paths";
import { ensureSessionWithRetry } from "@host/boot/startup";
import { makeCommandFileDispatch } from "@host/commands/command-file-dispatch";
import { loadCommandFiles } from "@host/commands/command-loader";
import { buildCommandRegistry } from "@host/commands/commands";
import { debugCommandSpecs } from "@host/commands/debug-commands";
import { resolveInterpolationConfig } from "@host/commands/interpolation";
import { createProgrammaticCommandDispatcher } from "@host/commands/programmatic-command";
import { hooksRuntime } from "@host/hooks/host-runtime";
import { lspManager } from "@host/lsp/host-runtime";
import { mcpRuntime } from "@host/mcp/host-runtime";
import { MODEL_PREFS_COMMANDS, runModelPrefsCommand } from "@host/prefs/model-prefs-command";
import { modelPrefs, saveModelPrefs } from "@host/prefs/model-prefs-store";
import { BUILTIN_STYLES, buildStyleMenu, DEFAULT_STYLE_ID } from "@host/prefs/styles";
import { createJobLedger } from "@host/processes/job-ledger";
import { processAlive } from "@host/processes/process-liveness";
import { supervisor } from "@host/processes/processes";
import {
  acquireCwdLock,
  type CwdLockOwner,
  nodeCwdLockCaps,
  releaseCwdLock,
} from "@host/session/cwd-lock";
import { Lease } from "@host/session/lease";
import { skillRegistry } from "@host/skills/skills";
import { describeAgent, discoverAgents } from "@host/subagents/discovery";
import { taskRegistry } from "@host/tools/tasks/tasks";
import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import * as Sentry from "@sentry/node";
import {
  catalogEntryFor,
  clipProducerId,
  controlProducerId,
  DEFAULT_SESSION_ID,
  decodeTrevorEvent,
  events,
  inputEstimateTokens,
  isAnswerableProducer,
  PRODUCER_IDS,
  recallProducerId,
  type SessionEvent,
  streamTransport,
  type TrevorEventInput,
  tangentsOf,
  toPublishInput,
  viewerIdentity,
} from "@trevor/session";
import { storagePathByName } from "@trevor/session/node-paths";
import { serviceUrl } from "@trevor/session/ports";
import { resolveTelemetryConfig } from "@trevor/session/telemetry";
import { createTelemetrySink } from "@trevor/session/telemetry-file-sink";
import { createProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";
import { capacityResolver, loadAdmissionConfig } from "./admission/config";
import { createLocalAdmissionGate } from "./admission/service";
import { nodeAdmissionCaps } from "./admission/store";
import { makeCompactionCommands } from "./agent/compaction-commands";
import { makeControlPrompts } from "./agent/control-prompts";
import type { BackgroundChildInfo } from "./agent/delegate";
import { providerQuestionRuntime } from "./agent/provider-questions";
import { recallEngine } from "./agent/recall/engine";
import { createSiblingReader } from "./agent/recall/reader";
import { makeLifecycleCommands } from "./commands/lifecycle";
import { defaultProbeTargets, nodeProbeIo } from "./connectivity/node-io";
import { InternetMonitor, probeInternet } from "./connectivity/probe";
import { buildLiveDoctorSnapshot, collectDoctorProbeResults } from "./doctor/build";
import { makeHostFacts } from "./doctor/host-facts";
import { currentDoctorSnapshot, registerDoctorSnapshotSource } from "./doctor/source";
import { buildFileIndex } from "./file-mention/file-index";
import { makeHandoffOrchestrator } from "./handoff/orchestrator";
import { createLoopPersistence } from "./loop/persistence";
import { createLoopIterationRunner, defaultProcessSeam } from "./loop/runner";
import { LoopStore } from "./loop/store";
import { assembleManifest } from "./manifest/build";
import { registerManifestSource } from "./manifest/source";
import { makeShellLane } from "./processes/shell-lane";
import { buildProviders, DEFAULT_PROVIDER, lmsBin } from "./providers";
import { type CatalogSnapshot, loadCatalog } from "./providers/catalog";
import { parseOverflowWindow } from "./providers/error-classifier";
import { recordLearnedWindow } from "./providers/model-metadata-overrides";
import { makeSourceSignIn } from "./providers/source-signin";
import { createHostResidency } from "./residency/host";
import { makeSerialRunCommands } from "./serial-run/commands";
import { makeSessionSwitch } from "./session/session-switch";
import { makeSessionWorker } from "./session/session-worker";
import { makeTangentAdoption } from "./session/tangent-adoption";
import { bootstrapNodeSentry } from "./telemetry/sentry";
import { registerToolScriptSink } from "./tool-script/sink";
import { READ_ONLY_TOOLS, TOOL_DEFS } from "./tools";
import { openInEditor } from "./tools/open-editor";
import { makePresence } from "./transport/presence";
import { nodeWorktreeManager } from "./worktrees";
import { makeWorktreeCommands } from "./worktrees/commands";

/**
 * Trevor host: a session participant that runs an agent loop (model <-> tools) for
 * each new user.message over the full conversation, via a per-message-selectable
 * Provider (local qwen, or GPT-5.x over Codex OAuth) - both with tool calling.
 * It builds history from the event log, gates on replay, reports cold/warm
 * readiness, and defaults to a shared session ("trevor-local") so host and
 * browser auto-attach; override with SESSION_ID.
 *
 * The session contract (event shape, the `events` constructors, `decodeTrevorEvent`)
 * lives in @trevor/session and is shared with the web client, so host and browser
 * can never disagree on the protocol. The durable log is reached through a
 * SessionTransport; by default this host plugs in the local session-store, and sets
 * TETHER_URL to opt into Tether instead. Either way the loop below depends only on
 * the contract, not on a backend.
 *
 * Many hosts may share one session (each with a distinct participant id so
 * Tether lets them coexist), but only the lease LEADER answers turns; others
 * stand by and take over if the leader goes quiet (see @host/session/lease).
 *
 * Responsible for: composition root: wiring transport, session lease, command lane, turn dispatch.
 * Not for: new pure logic - behavior lives in the modules this file wires.
 */

const SESSION_ID = process.env.SESSION_ID ?? DEFAULT_SESSION_ID;
const PRODUCER_ID = PRODUCER_IDS.host;
const CONTROL_PRODUCER_ID = controlProducerId(PRODUCER_ID);
// Host-issued prompts for a restricted `/clip <request>` turn (plan 06): a distinct control
// producer so `startTurn` narrows the turn's tool surface to clipboard_write only. Answerable
// (not the bare host id), but tagged so it is never treated as a normal full-surface turn.
const CLIP_PRODUCER_ID = clipProducerId(PRODUCER_ID);
// Backend selection (the plugin seam): default to the local session-store; set
// TETHER_URL to opt into the Tether durable substrate instead. The host speaks
// the SessionTransport contract either way.
const TETHER_URL = process.env.TETHER_URL;
const SESSION_STORE_URL = process.env.SESSION_STORE_URL ?? serviceUrl("store");
// Tether speaks the same SessionTransport contract as the local store, so backend selection is just
// which URL the stream transport points at (no separate adapter until Tether needs real divergence).
const transport = streamTransport(TETHER_URL ?? SESSION_STORE_URL);
// The host telemetry sink (plan 13 M5): NOOP unless TREVOR_OTEL_EXPORTER=file selects the local file
// exporter. Threaded into every turn (publishTurn) so turn/tool spans are emitted when enabled.
const hostTelemetry = createTelemetrySink("agent-host");
// Wire the host telemetry sink into tool_script's observability span (plan 16 M8).
registerToolScriptSink(hostTelemetry);
// The opt-in provider-attempt trace (plan 13 M6): a no-op unless TREVOR_PROVIDER_TRACE is set. Records
// a redacted terminal-failure record per turn for debugging a flaky provider, local-only.
const providerTrace = createProviderTraceWriter({
  enabled: resolveTelemetryConfig().providerTrace,
});
// Node Sentry error sink (plan 13 M9): initializes ONLY when a DSN is configured (never under test/CI),
// errors-only, every event scrubbed by the shared beforeSend. A no-op on a bare checkout. The
// `as NodeOptions` cast bridges the SDK-free option shape to the SDK's.
if (bootstrapNodeSentry({ init: (options) => Sentry.init(options as Sentry.NodeOptions) })) {
  log("host", "sentry error sink enabled (errors-only, scrubbed)");
}
// Local-model admission (plan 11): one cross-process gate per host serializes LM Studio generation +
// reload across projects/subagents, so parallel work shares the runtime without overload or reload
// races. Conservative default (capacity 1 per resource); foreground priority unless a future per-turn
// resolver refines it. Fail-open by construction - it never wedges a turn shut.
const admissionConfig = loadAdmissionConfig();
const admissionCaps = nodeAdmissionCaps({ staleAfterMs: admissionConfig.staleAfterMs });
const admissionGate = createLocalAdmissionGate({
  hostId: crypto.randomUUID(),
  newOwnerId: () => crypto.randomUUID(),
  caps: admissionCaps,
  capacityFor: capacityResolver(admissionConfig),
});
const execFileAsync = promisify(execFile);
/** Unloads a local model from the LM Studio runtime (`lms unload <model>`), used by residency eviction.
 *  execFile (not a shell) so an org-prefixed model id never needs quoting. */
async function unloadLocalModel(model: string): Promise<void> {
  await execFileAsync(lmsBin(), ["unload", model]);
}
// Local-model residency (plan 11.1): track which local models THIS instance loaded, claim the active one
// cross-process, and evict a model once no live instance still claims it (reference-counted, lease-safe).
// Its recorder is handed to the LM Studio slots; the turn loop reconciles it as each turn resolves its
// provider. Shares plan 11's caps + lifecycle lease so residency and admission never race the runtime.
const residency = createHostResidency({
  caps: admissionCaps,
  hostId: crypto.randomUUID(),
  pid: process.pid,
  withLifecycleLease: (target, fn) => admissionGate.withLifecycle(target, fn),
  unload: unloadLocalModel,
  staleAfterMs: admissionConfig.staleAfterMs,
});
const providers = buildProviders({ admissionGate, residency: residency.recorder });
// File-loaded custom commands (plan 44.5): `.trevor/commands/*.md` bodies with `$0`/`$ARGUMENTS`
// placeholders, loaded once at startup (a new/edited file needs a host restart, like skills). Their
// specs are announced on host.online so the web menu lists them; invoking one takes the SUBMIT branch
// below. A skip is fail-soft - it never blocks the rest of command registration.
const commandFileLoad = loadCommandFiles();
for (const diagnostic of commandFileLoad.diagnostics) {
  warn("host", "command file skipped", { path: diagnostic.path, code: diagnostic.code });
}
// Reserve the debug command names (`/restart`, `/stop`, ...) so a same-named `.trevor/commands/*.md`
// can't double-list itself beside its debug spec and shadow the real handler at dispatch (plan 44.5).
// The programmatic dispatcher's own names (`/worktree-*`, ...) are built further down and can't reach
// here (the registry is consumed by makePresence above) - a file so named still dispatches to the real
// handler; only its menu preview would mislead. That narrower gap is left as follow-up.
const commands = buildCommandRegistry(
  commandFileLoad.files,
  new Set(debugCommandSpecs(true).map((spec) => spec.name)),
);
// The `/loop` runtime (plan 17): the command surface drives a durable-loop store. Process loops run through
// the real command boundary; current-session + background prompt loops inject a control prompt into the
// session (a first cut - a dedicated background-agent spawn + a full turn-completion await are later
// refinements). Durable loops rehydrate from the state root at boot; status rides `loop.status` events.
const loopPersistence = createLoopPersistence();
const loops = new LoopStore({
  emit: (snapshot) => {
    void emit(events.loopStatus({ snapshot }));
  },
  makeId: () => `loop_${crypto.randomUUID().slice(0, 8)}`,
  runner: createLoopIterationRunner({
    runProcess: defaultProcessSeam,
    runPrompt: async (prompt) => {
      await publishControlPrompt(prompt);
      return { ok: true, summary: "prompt injected into the session" };
    },
    runBackground: async (prompt) => {
      await publishControlPrompt(prompt);
      return { ok: true, summary: "background prompt injected" };
    },
  }),
  persist: (record) => {
    loopPersistence.save(record);
  },
});
loops.hydrate(loopPersistence.load());
// The host-owned model source + catalog read model (D-065): which provider sources exist, their auth
// state, and each configured source's live model list. Loaded async (it hits each provider's /models),
// cached here, and announced on host.online; a re-announce fills it in once the first load resolves.
let catalog: CatalogSnapshot = { sources: [], catalogBySource: {} };
function refreshCatalog(): void {
  loadCatalog()
    .then((next) => {
      catalog = next;
      if (live && lease.isLeader()) {
        announceOnline();
      }
    })
    .catch((error) => warn("catalog", "load failed", { error: msg(error) }));
}

// Trevor-managed worktrees (D-091): the registry+git manager, rooted at TREVOR_STATE_HOME, with the
// shared home-abbreviation as its display closure.
const worktrees = nodeWorktreeManager(abbrevHome);

// Debug mode: a runtime flag (booted from `TREVOR_DEBUG`, set by `trevor --debug`, toggled at
// runtime by `/debug`) that gates a collection of dev-only host commands - hidden from a normal
// session. `/restart` re-execs the host to pick up code changes on demand; `/archive`, `/unarchive`,
// and `/stop` are the debug lifecycle controls (D-094 M4). The gated set + the `/stop` confirm live in
// debug-commands.ts (pure, unit-tested); the flag stays here (announceOnline and the replacement-host
// env read it), and the handlers in commands/lifecycle.ts are wired over it via {getDebug, setDebug}.
let debugMode = process.env.TREVOR_DEBUG === "1";

/** Stable per-process identity: shared producerId on events, unique stream id + instance. */
const INSTANCE_ID = crypto.randomUUID();
const PARTICIPANT_ID = `${PRODUCER_ID}:${INSTANCE_ID.slice(0, 8)}`;

// Cwd advisory lock (plan 01): this host owns the lock for WORKSPACE_ROOT while it is the session
// LEADER (the single mutating owner of the directory), so a SECOND session targeting the same real
// path is detected and surfaced instead of silently double-mutating it. Node-backed capabilities; the
// owner identity is this session + host instance + pid.
const cwdLockCaps = nodeCwdLockCaps();
const cwdLockOwner = (): CwdLockOwner => ({
  sessionId: SESSION_ID,
  hostId: INSTANCE_ID,
  pid: process.pid,
});

/** Acquire (or re-take) the cwd advisory lock for WORKSPACE_ROOT as the new leader. A different live
 *  session already owning the same realpath is surfaced (logged + shown in /doctor) rather than
 *  assumed; same-session failover/restart just re-takes it. Best-effort - never blocks leadership. */
function acquireWorkspaceCwdLock(): void {
  try {
    const result = acquireCwdLock(WORKSPACE_ROOT, cwdLockOwner(), cwdLockCaps);
    if (result.status === "conflict") {
      warn("host", "cwd lock contended by another session", {
        cwd: abbrevHome(WORKSPACE_ROOT),
        heldBy: result.heldBy.sessionId,
        pid: result.heldBy.pid,
      });
    } else if (result.status === "tookOverStale") {
      log("host", "cwd lock: reclaimed a stale lock", { previous: result.previous.sessionId });
    }
  } catch (error) {
    warn("host", "cwd lock acquire failed", { error: msg(error) });
  }
}

/** Release the cwd advisory lock if this exact process still holds it (graceful stop / exit). A crash
 *  skips this; the stale lock is reclaimed on the next acquire. Best-effort. */
function releaseWorkspaceCwdLock(): void {
  try {
    releaseCwdLock(WORKSPACE_ROOT, cwdLockOwner(), cwdLockCaps);
  } catch {
    // best-effort release
  }
}

// Single live connection's state (rebuilt from replay on each connect).
let live = false;
// The turn-dispatch state (active run, deferred FIFO, catch-up watermarks) lives in
// the SessionWorker constructed below, not in module mutables.

/** Publishes one event to the durable log, attaching this host's producerId. */
function emit(event: TrevorEventInput): Promise<void> {
  return transport.publishEvent(SESSION_ID, toPublishInput(event, PRODUCER_ID));
}

/** Cache window for the internet probe (D-060): reuse a result for ~30s to avoid constant checks. */
const INTERNET_CACHE_MS = 30_000;

/**
 * The host-owned internet monitor (D-060): probes public reachability (DNS + HTTPS), caches it, and
 * publishes `host.internet` on each transition - but only the LIVE LEADER publishes, so multiple
 * hosts on one session never flicker the advisory. Advisory only: it drives no routing.
 */
const internet = new InternetMonitor(
  () => probeInternet(defaultProbeTargets(), nodeProbeIo),
  INTERNET_CACHE_MS,
  Date.now,
  (snapshot) => {
    if (live && lease.isLeader()) {
      emit(events.hostInternet({ snapshot })).catch(() => {});
    }
  },
  (line) => {
    // Structured, redacted probe log (D-060 M4): a status change or settled failure, never the
    // configured endpoints. Logged on EVERY host (not just the leader) - each host's own view of
    // public reachability is worth a line; only the leader publishes the advisory event.
    (line.level === "warn" ? warn : log)("internet", line.message, line.fields);
  },
);

/**
 * Loudly flags a broken turn-machine rule without throwing. These are self-imposed
 * invariants the comments promise (one turn at a time; history stays strictly paired
 * user/assistant), but the host is a daemon that must stay up - so a violation is
 * surfaced and self-healed at the call site rather than crashing the only leader.
 */
function checkTurn(rule: boolean, message: string, fields?: Record<string, unknown>): void {
  if (!rule) {
    warn("host", `invariant: ${message}`, fields);
  }
}

// Every task_create/task_update mutates the shared registry; publish the new
// checklist so the UI updates and any replay/standby can restore from it.
taskRegistry.onChange(() => {
  emit(events.tasksCurrent({ tasks: taskRegistry.snapshot(), rev: taskRegistry.revision() })).catch(
    () => {},
  );
});

const lease = new Lease(
  INSTANCE_ID,
  {
    emitBeat: () => {
      emit(events.hostBeat({ instanceId: INSTANCE_ID })).catch(() => {});
    },
    emitHello: () => {
      emit(events.hostHello({ instanceId: INSTANCE_ID })).catch(() => {});
    },
    onRoleChange: (role) => {
      log("lease", "role", { role, instance: INSTANCE_ID.slice(0, 8) });
      emit(events.hostRole({ instanceId: INSTANCE_ID, role })).catch(() => {});
      if (role === "leader") {
        onBecomeLeader();
        // Adopt this session's tangents on becoming leader (the poll below keeps them current); a
        // standby drops any it held so tangents migrate with leadership.
        void reconcileTangents();
      } else {
        tangentAdoption.teardownAll();
      }
    },
  },
  leaseOptions(),
);

/** True between a `/compact` command and its `command.result`. If a host dies mid-fold the command
 *  is left with no result (a dangling `/compact` that looks broken); the next leader gives it one. */
let compactPending = false;

/** Background subagents currently running across the session (Phase 5 / D-048), keyed by child run id.
 *  Each OUTLIVES the parent turn that started it - the registry is session-level, not per-turn - so the
 *  cap holds across turns and /doctor can report active children. An entry clears when the child settles. */
const backgroundChildren = new Map<string, BackgroundChildInfo>();

let needsCompaction: ReturnType<typeof makeCompactionCommands>["needsCompaction"] = () => false;
let startCompaction: ReturnType<typeof makeCompactionCommands>["startCompaction"] = () => {};
let manualCompactFiber: ReturnType<typeof makeCompactionCommands>["manualCompactFiber"] = () =>
  null;

// Main-session worker: owns the shared per-session turn lifecycle objects while main.ts keeps the
// command, handoff, shell, source-auth, and other main-session-only event branches.
const mainWorker = makeSessionWorker({
  sessionId: SESSION_ID,
  producerId: PRODUCER_ID,
  instanceId: INSTANCE_ID,
  transport,
  providers,
  residency,
  internet,
  lease,
  hostTelemetry,
  providerTrace,
  backgroundChildren,
  compaction: { needed: () => needsCompaction(), run: () => startCompaction() },
  manualCompactFiber: () => manualCompactFiber(),
  activeChildSessionIds: () =>
    new Set(
      [...backgroundChildren.values()]
        .map((child) => child.childSessionId)
        .filter((id) => id.length > 0),
    ),
  pendingQuestionIds: () => providerQuestionRuntime.pendingIds(),
  onEvent: (message) => handleEvent(message),
  onReplayComplete: () => {
    live = true;
    goLive();
  },
  onStatus: (status) => {
    if (status === "open") {
      log("host", "joined session", { participant: PARTICIPANT_ID, session: SESSION_ID });
    } else if (status === "closed") {
      live = false;
      log("host", "socket closed; reconnecting", { ms: 1000 });
    }
  },
  autoConnect: false,
});

const conversationLog = mainWorker.conversationLog;
const turnMachine = mainWorker.turnMachine;
const compactionController = mainWorker.compactionController;
const activeRun = mainWorker.activeRun;
const scheduler = mainWorker.scheduler;
const { abortRuns, reapOrphans, reapOrphanSubagents, reapOrphanQuestions } = mainWorker;

// The ask_user pending-question runtime publishes its request/resolved events through this host's emit
// (fire-and-forget). The blocking + answer routing live in the runtime; main.ts only wires the boundary.
providerQuestionRuntime.configure((event) => {
  void mainWorker.emit(event);
});

// Tangent adoption (plan 37 takeover): the parent host ALSO answers the tangents branched off this
// session, each in an isolated per-tangent worker (its own log/turn machinery, `startTurn` bound to
// the tangent id) - never a fork. The manager is session-agnostic; `reconcileTangents` below feeds it
// the discovered tangent ids while this host is the live leader. Gated on the same lease as the main
// session, so workers migrate with leadership.
const tangentAdoption = makeTangentAdoption({
  parentSessionId: SESSION_ID,
  producerId: PRODUCER_ID,
  instanceId: INSTANCE_ID,
  transport,
  providers,
  residency,
  internet,
  lease,
  hostTelemetry,
  providerTrace,
});

/**
 * Reconciles the adopted-tangent workers to the parent's live tangents. Only the LIVE LEADER adopts:
 * off-live or as a standby it tears every worker down (so tangents migrate with leadership), else it
 * reads the inventory, filters to THIS session's non-deleted tangents (tangentsOf), and converges the
 * worker set. Best-effort - an inventory read failure leaves the current workers in place. Driven
 * from the leadership transition (below) and a modest poll (bottom of file).
 */
let reconcilingTangents = false;
async function reconcileTangents(): Promise<void> {
  if (!live || !lease.isLeader()) {
    tangentAdoption.teardownAll();
    return;
  }
  // Never stack inventory fetches: if the poll ticks (or a leadership transition fires) while a prior
  // fetch is still in flight, skip - a slow/wedged store must not have 4s ticks pile requests onto it.
  if (reconcilingTangents) {
    return;
  }
  reconcilingTangents = true;
  try {
    const summaries = await transport.fetchInventory();
    tangentAdoption.reconcile(tangentsOf(summaries, SESSION_ID).map((s) => s.sessionId));
  } catch (error) {
    warn("host", "tangent reconcile failed", { error: msg(error) });
  } finally {
    reconcilingTangents = false;
  }
}

// The compaction command lane (plan 22.3, agent/compaction-commands): the between-turn fold gate
// + trigger, the manual /compact fold (with its ESC-interruptible fiber, read back through the
// manualCompactFiber getter), and the fold-progress throttle. Constructed BEFORE the scheduler -
// whose compaction gate takes needsCompaction/startCompaction below - so the scheduler half is
// threaded lazily.
const compactionCommands = makeCompactionCommands({
  producerId: PRODUCER_ID,
  emit,
  compactionController,
  conversationLog,
  live: () => live,
  lease,
  scheduler: () => scheduler,
});
needsCompaction = compactionCommands.needsCompaction;
startCompaction = compactionCommands.startCompaction;
manualCompactFiber = compactionCommands.manualCompactFiber;
const { forceCompact } = compactionCommands;

// The host-issued control prompts + continuation lane (plan 22.3, agent/control-prompts): the
// control/clip prompt shapes, the continue/retry/compress flows, the /clip lane, and the bounded
// auto-resume - wired over the live projection + transport (constructed after the compaction lane so
// forceCompact passes directly). The LoopStore runner above closes over
// `publishControlPrompt` and only dereferences it when a loop iteration fires (runtime), so this
// destructure sitting after the store's construction is TDZ-safe.
const {
  controlModel,
  publishControlPrompt,
  continueAfterStop,
  retryLastPrompt,
  runClip,
  compressThenContinue,
  maybeAutoResume,
} = makeControlPrompts({
  sessionId: SESSION_ID,
  producerId: PRODUCER_ID,
  controlProducerId: CONTROL_PRODUCER_ID,
  clipProducerId: CLIP_PRODUCER_ID,
  transport,
  emit,
  conversationLog,
  compactionController,
  turnMachine,
  forceCompact,
});

// The file-loaded-command SUBMIT branch (plan 44.5, M4): expands a `.trevor/commands/*.md` body
// (interpolate-then-substitute, D-007) and publishes it as the turn's prompt through the control-prompt
// seam - so a custom command drives the model like a typed prompt, not a `command.result`. Wired after
// `publishControlPrompt` exists; the dispatch calls it only on the live leader (below).
const commandFileDispatch = makeCommandFileDispatch({
  interpolationConfig: resolveInterpolationConfig(process.env),
  publish: publishControlPrompt,
  emitResult: (result) => emit(events.commandResult(result)),
});

// The host presence surface (plan 22.3, transport/presence): the git/worktree projections + the
// idempotent host.online announcement - wired over the live providers/commands/catalog/debug
// state; refreshCatalog, the command lanes, the shell lane, and the doctor facts keep dispatching
// under the same local names.
const { currentGit, currentWorktrees, announceOnline } = makePresence({
  providers,
  commands,
  debugMode: () => debugMode,
  worktrees,
  internet,
  catalog: () => catalog,
  instanceId: INSTANCE_ID,
  emit,
});

// Re-announce host.online whenever a *visible* tracked job changes (a `process` start or a promoted
// command's start / exit / kill / promote / remove), so the support panel reflects it live without polling
// (plan 09 M7). The supervisor already gates this to visible jobs, so an ordinary foreground command fires
// nothing; each announce is a full host.online snapshot the web folds via latest(), so a re-emit is a
// harmless no-op for consumers (it is not debounced - the gating is what bounds the volume).
supervisor.onChange = announceOnline;

// The background-job watchdog (plan 09 hardening): a per-session persisted ledger of running jobs, so a
// restarting host reaps the dev servers/watchers a CRASHED prior host left running (a graceful STOP
// already killAll()s them) instead of trusting its last published snapshot. Attached after the module
// singleton is constructed (it can't take the per-session path at import time); the reconcile itself is
// leader-gated (boot/leadership), so it runs once on takeover, never from a standby.
supervisor.attachLedger(
  createJobLedger(join(storagePathByName("jobs-ledger"), `${SESSION_ID}.json`)),
);
/** The full command line of a pid (`ps -p <pid> -ww -o command=`), or null when unknown/gone. Used ONLY
 *  to confirm a ledger pid is really one of this session's jobs before reaping it - never to decide alone. */
function pidCommand(pid: number): string | null {
  try {
    return execSync(`ps -p ${pid} -ww -o command=`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
/** Leader-gated: reap background jobs a prior crashed host left running. Command-verified SIGTERM (a
 *  reused pid is spared), then the host.online announce boot/leadership already fires publishes the
 *  corrected snapshot. Best-effort logging - a reap failure never affects a turn. */
const reapOrphanJobs = (): void => {
  const { killed, spared } = supervisor.reconcileOrphans({
    isAlive: processAlive,
    commandOf: pidCommand,
    terminate: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // raced out between the liveness check and the signal - already gone
      }
    },
  });
  if (killed.length > 0 || spared.length > 0) {
    log("host", "job watchdog reconcile", { killed: killed.length, spared: spared.length });
  }
};

// Go-live + leadership transitions (plan 22.3, boot/leadership): the once-only lease/heartbeat
// start + reconnect reconcile, and the leader-transition reconcile (cwd lock, orphan reap,
// dangling-/compact result, catch-up, pre-warm) - wired over the lease/scheduler and the
// reap/resume/announce seams. The Lease's onRoleChange closure above resolves `onBecomeLeader` at
// role-change time (runtime), so this destructure sitting after the Lease construction is TDZ-safe.
const { goLive, onBecomeLeader } = makeLeadership({
  instanceId: INSTANCE_ID,
  emit,
  lease,
  scheduler,
  selfProducerId: PRODUCER_ID,
  conversationEvents: () => conversationLog.events(),
  turnMachine,
  internet,
  providers,
  residency,
  live: () => live,
  getCompactPending: () => compactPending,
  setCompactPending: (value) => {
    compactPending = value;
  },
  manualCompactFiber,
  acquireWorkspaceCwdLock,
  cwdLockOwner,
  cwdLockCaps,
  announceOnline,
  reapOrphans,
  reapOrphanSubagents,
  reapOrphanQuestions,
  reapOrphanJobs,
  maybeAutoResume,
});

// The prompt-shell lane (plan 22.3, processes/shell-lane): `!command` execution through the
// promotable runner, publishing one shell.result per request - wired over emit + the git
// re-announce; handleEvent's user.shell arm dispatches into it.
const { runShellCommand } = makeShellLane({ emit, announceOnline });

// Host-driven source SIGN-IN (D-065 M5, providers/source-signin): wired over emit + the catalog
// refresh.
const { startSourceSignIn, cancelSignIn, submitSignInCode } = makeSourceSignIn({
  emit,
  refreshCatalog,
});

// The session-switch mechanics (/clear, /cd, and the shared workspace-switch gate + mechanic,
// session/session-switch): wired over the live scheduler/turn/subagent state + the debug flag.
const {
  spawnReplacementHost,
  retireAfterSessionSwitch,
  dropSessionLocalState,
  announceSwitchAndRetire,
  clearToFreshSession,
  blockedFromWorkspaceSwitch,
  cdToFreshSession,
  switchToWorkspace,
} = makeSessionSwitch({
  sessionId: SESSION_ID,
  transport,
  emit,
  scheduler,
  turnMachine,
  manualCompactFiber,
  backgroundChildren,
  debugMode: () => debugMode,
});

// The /handoff orchestration (02/02.10, handoff/orchestrator): wired over the live switch
// mechanics + control-model resolution.
const { runHandoff, approveHandoff, rejectHandoff, noteGenerated, noteSettled, handoffDeps } =
  makeHandoffOrchestrator({
    sessionId: SESSION_ID,
    producerId: PRODUCER_ID,
    controlProducerId: CONTROL_PRODUCER_ID,
    transport,
    emit,
    conversationLog,
    compactionController,
    controlModel,
    blockedFromWorkspaceSwitch,
    spawnReplacementHost,
    announceSwitchAndRetire,
  });

// The /serial-implement|next|dispose command handlers (plan 02, serial-run/commands): wired over
// the shared workspace-switch gate + the handoff execution deps.
const { runSerialImplement, runSerialNext, runSerialDispose } = makeSerialRunCommands({
  emit,
  blockedFromWorkspaceSwitch,
  handoffDeps,
  worktrees,
});

// The programmatic /worktree-* handlers (D-091, worktrees/commands): wired over the manager + the
// shared workspace-switch gate/mechanic.
const { worktreeSwitch, worktreeNew, worktreeMerge, worktreeDelete, worktreeReconcile } =
  makeWorktreeCommands({
    worktrees,
    cwdLockCaps,
    emit,
    blockedFromWorkspaceSwitch,
    switchToWorkspace,
    announceOnline,
  });

// The debug lifecycle commands (/debug, /restart, /archive, /unarchive, /stop) and the graceful
// stop (D-094, commands/lifecycle): wired over the live switch mechanics + teardown seams + the
// {getDebug, setDebug} debug-flag threading.
const { toggleDebug, restartHost, performGracefulStop, setArchived, stopCurrentSession } =
  makeLifecycleCommands({
    sessionId: SESSION_ID,
    emit,
    announceOnline,
    getDebug: () => debugMode,
    setDebug: (on) => {
      debugMode = on;
    },
    spawnReplacementHost,
    retireAfterSessionSwitch,
    releaseWorkspaceCwdLock,
    residency,
    abortRuns,
    scheduler,
  });

// The live host facts /doctor reads (D-073, doctor/host-facts): wired over the host's live
// singletons, so the /doctor command and the model-facing `doctor` tool draw from the same state.
const { doctorFacts } = makeHostFacts({
  scheduler,
  turnMachine,
  compactionController,
  internet,
  live: () => live,
  historyLength: () => conversationLog.history().length,
  backgroundChildren,
  currentWorktrees,
  currentGit,
  catalog: () => catalog,
  lease,
  instanceId: INSTANCE_ID,
  sessionId: SESSION_ID,
  admissionCaps,
  residency,
  hostTelemetry,
  cwdLockCaps,
  // The MCP runtime (plan 23 M8): its status snapshot feeds the /doctor MCP area + debug line.
  mcp: mcpRuntime,
  // The LSP manager (plan 24 M8): its status snapshot feeds the /doctor LSP area + debug line.
  lsp: lspManager,
  // The hooks runtime (plan 25 M9): its status + stats snapshots feed the /doctor Hooks area
  // (trust states, approval/script/performance/legacy findings) + debug line.
  hooks: hooksRuntime,
});

// The `doctor` tool (D-073 M6) has no CommandContext, so the host registers the snapshot accessor it
// reads: the SAME builder + facts the /doctor command uses, so command and tool never disagree.
registerDoctorSnapshotSource(async () =>
  buildLiveDoctorSnapshot({
    runtime: doctorFacts(),
    probes: await collectDoctorProbeResults(providers, { telemetry: hostTelemetry }),
  }),
);

// The capability manifest (plan 14) reads the SAME live registries the announced inventory, /help, and
// /doctor read, so `/trevor-export` and the built-in trevor-expert never disagree with them. The catalog
// load and doctor snapshot are best-effort - a failed read degrades that one section to unavailable, never
// the whole export.
registerManifestSource(async (scope) => {
  // Each eager registry read is best-effort: a throw degrades ONLY its section (to empty/unavailable),
  // never the whole export - matching the per-provider guard buildManifest already applies.
  const readOr = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  let catalog: CatalogSnapshot | null = null;
  try {
    catalog = await loadCatalog();
  } catch {
    catalog = null;
  }
  const doctor = await currentDoctorSnapshot().catch(() => null);
  return assembleManifest(
    {
      toolDefs: TOOL_DEFS,
      readOnlyTools: READ_ONLY_TOOLS,
      commands: commands.specs,
      // The full debug capability surface, regardless of the runtime toggle - the manifest DESCRIBES what
      // the host can do; scope filtering (compact/subagent/expert) drops debug for prompt-facing readers.
      debugCommands: debugCommandSpecs(true),
      commandFamilies: [buildStyleMenu(DEFAULT_STYLE_ID)],
      styles: BUILTIN_STYLES,
      skills: readOr(() => skillRegistry(), []),
      agents: readOr(() => discoverAgents().map(describeAgent), []),
      doctorAreas: doctor?.areas ?? [],
      catalog,
      runtime: {
        role: lease.isLeader() ? "leader" : "standby",
        instanceId: INSTANCE_ID.slice(0, 8),
      },
      host: {},
      workspace: { root: WORKSPACE_ROOT, cwd: WORKSPACE_ROOT },
    },
    scope,
    new Date().toISOString(),
  );
});

/**
 * Runs an immediate host command and publishes its result. Unlike a user.message
 * this never touches the model or the turn queue - it executes now, even while a
 * turn is streaming, and answers with a single command.result.
 */
async function runCommand(name: string, args: string): Promise<void> {
  const { text, ok, menu } = await commands.run(name, args, {
    providers,
    cwd: process.cwd(),
    doctor: { ...doctorFacts(), lease: lease.debugInfo(Date.now()) },
    doctorProbeOptions: { telemetry: hostTelemetry },
    compact: forceCompact,
    loops,
  });
  await emit(events.commandResult({ command: name, text, ok, ...(menu ? { menu } : {}) }));
  // `/vim` flips the Vim-motions preference that host.online carries; re-announce so every client's
  // `vimEnabled` updates without a restart (same pattern as the shell/debug re-announces).
  if (name === "/vim" && ok) {
    announceOnline();
  }
}

const programmaticCommands = createProgrammaticCommandDispatcher({
  handlers: [
    { name: "/clear", run: () => clearToFreshSession() },
    { name: "/cd", run: (args) => cdToFreshSession(args) },
    {
      name: "/continue",
      run: async (args) => {
        await continueAfterStop(args.trim() || turnMachine.lastTermination || "manual continue");
        await emit(
          events.commandResult({
            command: "/continue",
            text: "Continuing from the paused turn.",
            ok: true,
          }),
        );
      },
    },
    {
      name: "/compress",
      run: async () => {
        const result = await compressThenContinue();
        await emit(events.commandResult({ command: "/compress", ...result }));
      },
    },
    {
      name: "/retry",
      run: async () => {
        const result = await retryLastPrompt();
        await emit(events.commandResult({ command: "/retry", ...result }));
      },
    },
    { name: "/internet-refresh", run: () => internet.refresh() },
    { name: "/catalog-refresh", run: () => refreshCatalog() },
    // The model-preference mutations (plan 51): set the durable default / toggle a favorite. Each
    // persists host-side and re-announces (the /vim re-announce pattern) so every open client updates
    // without a restart; a malformed ref is rejected without a write. Registered from the one command
    // list so the wiring can't drift from the command module.
    ...MODEL_PREFS_COMMANDS.map((name) => ({
      name,
      run: (args: string) =>
        runModelPrefsCommand(
          { load: modelPrefs, save: saveModelPrefs, emit, announce: announceOnline },
          name,
          args,
        ),
    })),
    { name: "/source-signin", run: (args) => startSourceSignIn(args.trim()) },
    { name: "/source-signin-cancel", run: () => cancelSignIn() },
    { name: "/source-signin-code", run: (args) => submitSignInCode(args.trim()) },
    { name: "/worktree-switch", run: (args) => worktreeSwitch(args.trim()) },
    { name: "/worktree-new", run: (args) => worktreeNew(args) },
    { name: "/worktree-merge", run: (args) => worktreeMerge(args) },
    { name: "/worktree-delete", run: (args) => worktreeDelete(args) },
    { name: "/worktree-reconcile", run: () => worktreeReconcile() },
    { name: "/debug", run: () => toggleDebug() },
    { name: "/restart", run: (args) => restartHost(args) },
    { name: "/archive", run: () => setArchived(true) },
    { name: "/unarchive", run: () => setArchived(false) },
    { name: "/stop", run: (args) => stopCurrentSession(args) },
    { name: "/handoff", run: (args) => runHandoff(args) },
    { name: "/serial-implement", run: (args) => runSerialImplement(args) },
    { name: "/serial-next", run: (args) => runSerialNext(args) },
    { name: "/serial-dispose", run: (args) => runSerialDispose(args) },
    { name: "/clip", run: (args) => runClip(args) },
  ],
  // A file-loaded custom command (plan 44.5) takes the SUBMIT branch: expand its body and publish it as
  // the turn's prompt. Everything else (built-in immediate commands) keeps the command.result lane with
  // its raw `args` unchanged - so immediate TS commands are unaffected.
  fallback: (command, args) => {
    const file = commands.commandFile(command);
    return file ? commandFileDispatch.submit(file, args) : runCommand(command, args);
  },
});

/** Admits one event to the prompt projection and recomputes the derived history.
 *  The fold (mapping, artifacts, blank-filter, user collapse, /clear reset, tool reconstruction)
 *  is owned by buildHistory; this is the only place `history` is rebuilt. */
function admit(event: SessionEvent): void {
  conversationLog.admit(event);
}

/** Pushes an event into the durable history WITHOUT rebuilding the projection - for events that
 *  accumulate but only matter at a turn boundary: tool.started/completed (buildHistory reconstructs
 *  them into the conversation and carries them across turns) and tasks.current (the compaction pin).
 *  `history` is read only at turn boundaries, so the next admit (the turn's assistant.completed, then
 *  the following user.message) rebuilds with them - a tool-heavy turn, or a burst of task updates,
 *  never re-folds the whole log per event. */
function recordEvent(event: SessionEvent): void {
  conversationLog.record(event);
}

/** Applies one live or replayed session event to the host's in-memory state. */
function handleEvent(message: SessionEvent): void {
  const decoded = decodeTrevorEvent(message);
  if (!decoded) {
    return;
  }
  if (decoded.type === "user.message" && isAnswerableProducer(message.producerId, PRODUCER_ID)) {
    mainWorker.observePromptProvider(message);
    scheduler.noteTurn(message);
  } else if (
    decoded.type === "user.supersede" &&
    isAnswerableProducer(message.producerId, PRODUCER_ID)
  ) {
    // A queued follow-up was retracted on the durable log (plan 47 D-003): drop it from the deferred
    // queue + catch-up target (scheduler), and admit the event so the prompt projection excludes the
    // superseded message. The active turn is untouched - supersede is a no-op for an attempted prompt.
    scheduler.noteTurn(message);
    admit(message);
    if (live && lease.isLeader()) {
      log("host", "supersede", { count: decoded.supersedes.length, reason: decoded.reason });
    }
  } else if (decoded.type === "assistant.started") {
    // Track the run as in flight (a started with no completion) so a later leader can reap it if a
    // crash/reload leaves it dangling. Cleared on its completion below.
    turnMachine.start(decoded.runId);
    // Note the attempt so catch-up never re-runs this prompt after a restart (replayed too).
    scheduler.noteTurn(message);
  } else if (decoded.type === "assistant.progress") {
    // Track the LIVE prompt size as the turn streams, so the compaction gate + /compact's reported
    // before-size stay current even when the turn is CANCELLED (a cancel carries no usage of its
    // own). Also stash the per-run usage so the cancel/reap completion can carry it.
    if (decoded.usage) {
      // Budget off the LARGER of the provider's reported input and the assembled-history chars/4
      // estimate (03.2 D-002): a provider that under-counts (cached/billable input below the full
      // prompt) no longer hides a history the pre-send guard later trips on, so the fold schedules.
      const assembledEstimate = decoded.breakdown ? inputEstimateTokens(decoded.breakdown) : 0;
      compactionController.noteUsage(
        decoded.usage.input,
        decoded.usage.contextWindow,
        assembledEstimate,
      );
      turnMachine.progress(decoded.runId, decoded.usage, decoded.breakdown);
    }
  } else if (decoded.type === "assistant.completed") {
    // Record WHY this turn ended (Phase 2 M4) before the overflow flag is reaped, so /doctor can
    // report the reason for the most recent turn (read back via `turnMachine.lastTermination`).
    turnMachine.complete(decoded);
    // Invariant: history stays strictly paired - an assistant reply lands only on top
    // of the user turn it answers. A different role on top means the pairing the loop
    // depends on has drifted (e.g. a missed/duplicated turn). Checked against the
    // pre-admit projection; buildHistory then drops a blank/whitespace-only completion
    // (the empty-reply poison) and appends only a real reply.
    if (decoded.text.trim()) {
      const currentHistory = conversationLog.history();
      const last = currentHistory[currentHistory.length - 1];
      checkTurn(last?.role === "user", "assistant reply with no preceding user turn", {
        last: last?.role ?? "none",
      });
    }
    admit(message);
    // Capture this turn's prompt size + window for the compaction gate, and clear the fold floor
    // (a fresh turn moved the needle, so a fold worth trying may exist again).
    if (decoded.usage) {
      const assembledEstimate = decoded.breakdown ? inputEstimateTokens(decoded.breakdown) : 0;
      compactionController.noteTurnCompleted(decoded.usage, assembledEstimate);
    } else {
      compactionController.noteTurnCompleted();
    }
    // The turn finished: free the slot + note the answered seq, drain whatever queued while it ran
    // (blocking-before: a queued prompt folds first if over budget), then fold proactively in the
    // idle slot when nothing is queued (D-041) - that ordering is owned by processCompletion. The
    // next turn's prompt view already includes this reply (admitted just above). Inert off-live: the
    // forked `start` returns null during replay and the proactive fold gates on liveness.
    scheduler.processCompletion(decoded.runId, message.seq);
    // Auto-resume from the just-admitted completion: a step-budget pause, or a host-restart interrupt
    // this leader reaped live (its echo lands here). The browser-recovered case - an interrupt already
    // in the log when this host took over - is caught by goLive/onBecomeLeader instead.
    if (live && lease.isLeader()) {
      maybeAutoResume();
    }
  } else if (decoded.type === "context.compacted") {
    // A fold landed (our own echo, or the leader's on a standby): admit it so the projection
    // shrinks to pins + summary + recent, drop the budget estimate to its post-fold size, and
    // release the compaction gate so any turn deferred behind it can now start.
    admit(message);
    compactionController.noteCompacted({
      throughSeq: decoded.throughSeq,
      tokensBefore: decoded.tokensBefore,
      tokensAfter: decoded.tokensAfter,
    });
    scheduler.finishCompaction();
  } else if (decoded.type === "assistant.overflow") {
    // Recovery was exhausted for this run (D-034). Note it so the turn's termination reason reads
    // "overflow" if it then ends with no real answer (Phase 2 M4).
    turnMachine.overflow(decoded.runId);
    // Self-heal a stale model window from the provider's OWN overflow (03.2 M3): when the reason
    // reveals a real window for the foreground model, learn it so the next turn on that model budgets
    // against reality. Keyed by model; only tightens. Replayed too, so the heal survives a restart.
    const overflowedModel = compactionController.providerOrDefault()?.model;
    const learnedWindow = parseOverflowWindow(decoded.reason);
    if (
      overflowedModel &&
      learnedWindow !== null &&
      recordLearnedWindow(overflowedModel, learnedWindow)
    ) {
      log("host", "window self-heal", {
        model: overflowedModel,
        learnedWindow,
        source: "overflow-error",
      });
    }
  } else if (decoded.type === "tool.started" || decoded.type === "tool.completed") {
    // Record the turn's tool activity so buildHistory carries the calls + results into the next
    // turn's prompt (the model keeps what it read until compaction folds it). Not re-projected per
    // call; the turn's assistant.completed admit rebuilds with them.
    recordEvent(message);
  } else if (decoded.type === "user.cancel" && live && lease.isLeader()) {
    // LIVE LEADER ONLY. Cancel is IMMEDIATE: publish the cancelled completion now - so every client
    // frees this instant (the turn shows cancelled, the send queue drains) - and interrupt the fiber
    // to tear the model request down. The fiber's own onExit completion is deduped, so the run closes
    // exactly once. This also closes an ORPHAN (a dead run with no fiber): the emit alone ends it. An
    // empty runId means "whatever is active" - close every in-flight run.
    //
    // The live+leader gate is load-bearing: a cancel is an ACTION, not state to rebuild. Its
    // completions are already in the durable log; re-running this on replay would RE-EMIT a fresh
    // cancelled burst for every in-flight run at that point - which is what made each host restart
    // republish a wall of "cancelled" completions. Replay just lets those logged completions stand.
    abortRuns(decoded.runId, decoded.steered === true ? "steered" : "cancelled");
  } else if (decoded.type === "model.switch.requested" && live && lease.isLeader()) {
    // LIVE LEADER ONLY (09.1). Route the switch into the in-flight turn's cell; the loop re-resolves at
    // its next step boundary and the host then emits model.switched. A request whose runId is not the
    // active switchable turn (or with no active turn) is a loop no-op - the web keeps its next-turn
    // selection (today's behavior). Like a cancel this is an ACTION, not state to rebuild on replay, so
    // it is gated live+leader and never re-applied during reconnect.
    const switchCell = activeRun.switchCellFor(decoded.runId);
    if (decoded.model && switchCell) {
      const target = decoded.model;
      const reasoning = target.reasoning;
      // The target model's context window from the catalog (09.1 M7), so the loop can run the
      // larger->smaller fit guard; absent when the source/model is not in the catalog (guard then off).
      const targetWindow = catalogEntryFor(catalog.catalogBySource, target)?.contextLength;
      switchCell.request({
        model: target,
        ...(reasoning != null ? { reasoning } : {}),
        initiator: decoded.initiator,
        ...(targetWindow != null ? { targetWindow } : {}),
      });
    }
  } else if (
    decoded.type === "user.command" &&
    isAnswerableProducer(message.producerId, PRODUCER_ID)
  ) {
    if (decoded.command === "/compact") {
      compactPending = true; // cleared by its command.result; reaped if a restart interrupts it
    }
    if (decoded.command === "/clear") {
      // Admit the clear so the projection resets from this point - applied on replay
      // too, so a reload/restart stays clean. The old events remain in the durable log
      // but buildHistory drops everything before the clear, and strips a stray leading
      // assistant turn if a clear lands mid-answer. The scheduler drops its queued
      // prompts + catch-up target alongside (the active run is left to finish).
      admit(message);
      dropSessionLocalState();
    }
    // Immediate command lane: only the leader answers, and only when live (commands
    // are actions, not state to rebuild on replay).
    if (live && lease.isLeader()) {
      const { command, args } = decoded;
      log("host", "command", { command, args: args || undefined });
      programmaticCommands.dispatch(command, args);
    }
  } else if (decoded.type === "command.result") {
    // A /compact resolved (✓ / nothing / cancelled / failed): it no longer needs a result. Tracked
    // on replay too, so a fresh leader only reaps a genuinely-dangling /compact.
    if (decoded.command === "/compact") {
      compactPending = false;
    }
  } else if (
    decoded.type === "editor.open" &&
    isAnswerableProducer(message.producerId, PRODUCER_ID)
  ) {
    // Side-channel action (like commands): only the live leader acts, never on
    // replay - opening a file is a one-shot effect, not state to rebuild.
    if (live && lease.isLeader() && decoded.path) {
      log("host", "editor.open", { path: decoded.path });
      openInEditor(decoded.path, decoded.line, decoded.column).catch((error) =>
        warn("host", "editor.open failed", { path: decoded.path, error: msg(error) }),
      );
    }
  } else if (
    decoded.type === "user.shell" &&
    isAnswerableProducer(message.producerId, PRODUCER_ID)
  ) {
    // The prompt shell lane (D-082): a leading `!` ran a command. Like commands and editor.open it
    // is an ACTION, not state to rebuild - only the live leader executes it, never on replay or a
    // standby, so a reload never re-runs the command. The result is published as a `shell.result`
    // (paired by requestId), rendered as a terminal block; it never enters the model context.
    if (live && lease.isLeader() && decoded.command.trim()) {
      runShellCommand(decoded.requestId, decoded.command).catch((error) =>
        warn("host", "shell failed", { error: msg(error) }),
      );
    }
  } else if (
    decoded.type === "file.index.requested" &&
    isAnswerableProducer(message.producerId, PRODUCER_ID)
  ) {
    // The `@`-file-mention picker (plan 30) asked for the workspace file index. A side-channel action
    // (like editor.open): only the live leader answers, never on replay/standby - it is a one-shot
    // read model, not state to rebuild. The result (relative paths only) is published paired by
    // requestId and never enters the model context; the browser fuzzy-filters it locally.
    if (live && lease.isLeader()) {
      const { files, truncated } = buildFileIndex();
      log("host", "file.index", { files: files.length, truncated });
      void emit(events.fileIndexResult({ requestId: decoded.requestId, files, truncated }));
    }
  } else if (
    decoded.type === "provider.question.answer" &&
    isAnswerableProducer(message.producerId, PRODUCER_ID)
  ) {
    // The browser answered a pending ask_user question. Only the live leader (which owns the blocked
    // tool call) resolves it; the runtime validates the answer, unblocks the tool, and emits the
    // resolution. An unknown id (AQ001) or an answer that fails validation (AQ002) is logged and left
    // for the browser to correct - it never disturbs an active run.
    if (live && lease.isLeader()) {
      const result = providerQuestionRuntime.submitAnswer(decoded.questionId, decoded.answer);
      if (result.status === "unknown") {
        warn("host", "ask_user answer for unknown question", { questionId: decoded.questionId });
      } else if (result.status === "invalid") {
        warn("host", "ask_user answer failed validation", {
          questionId: decoded.questionId,
          issues: result.issues,
        });
      }
    }
  } else if (decoded.type === "handoff.generated") {
    // Track the draft so an approval can run it - on replay too, so a fresh leader that took over after
    // the draft was written can still honor the approval (it is rebuildable state, not an action).
    noteGenerated(decoded.handoffId, decoded.prompt);
  } else if (decoded.type === "handoff.accepted" || decoded.type === "handoff.failed") {
    // Terminal lifecycle: the draft is resolved, so drop it from the pending set (replay-safe).
    noteSettled(decoded.handoffId);
  } else if (
    decoded.type === "handoff.approved" &&
    isAnswerableProducer(message.producerId, PRODUCER_ID)
  ) {
    // The browser approved a generated handoff draft. Like commands it is an ACTION (it spawns + switches),
    // so only the live leader runs it, never on replay or a standby. `prompt` is set only when the user
    // edited the draft in the prompt editor; otherwise approveHandoff falls back to the stored draft.
    if (live && lease.isLeader()) {
      approveHandoff(decoded.handoffId, decoded.prompt).catch((error) =>
        warn("host", "handoff approve failed", { error: msg(error) }),
      );
    }
  } else if (decoded.type === "handoff.rejected") {
    // Terminal cleanup on every host (replay-safe); only the live leader acknowledges with one command
    // result. `rejectHandoff` re-drops the (already-cleared) draft idempotently and leaves source active.
    noteSettled(decoded.handoffId);
    if (live && lease.isLeader() && isAnswerableProducer(message.producerId, PRODUCER_ID)) {
      rejectHandoff(decoded.handoffId).catch((error) =>
        warn("host", "handoff reject failed", { error: msg(error) }),
      );
    }
  } else if (decoded.type === "tasks.current") {
    // Recorded WITHOUT a rebuild: the task list only matters as a compaction pin (history-projection)
    // read at the next turn boundary, so a burst of task updates never re-folds the whole log per
    // update - the next real admit (the turn's completion) picks up the latest tasks.
    recordEvent(message);
    // Restore the checklist from the log on replay, and keep standbys in sync for
    // failover. The live leader owns the registry (it mutates it directly), so it
    // ignores the read-back of its own snapshot to avoid clobbering newer edits. On the
    // standby/replay path, loadIfFresh additionally rejects a stale (out-of-order or
    // late) snapshot by its revision, so an old tasks.current can never overwrite newer
    // task state. <!-- D-004 -->
    if (!live || !lease.isLeader()) {
      taskRegistry.loadIfFresh(decoded.tasks, decoded.rev);
    }
  } else if (live && (decoded.type === "host.beat" || decoded.type === "host.hello")) {
    if (decoded.instanceId) {
      lease.observe(
        decoded.instanceId,
        decoded.type === "host.beat" ? "beat" : "hello",
        Date.now(),
      );
    }
  }
}

/** A short label for the current session (its first user message), for recall source citations. */
function currentLabel(): string {
  return conversationLog.label(SESSION_ID);
}

/** Basename of a path (after home-abbreviation), matching the inventory's project projection. */
function projectName(path: string): string {
  const trimmed = abbrevHome(path).replace(/\/+$/, "");
  const base = trimmed.split("/").pop();
  return base && base.length > 0 ? base : trimmed;
}

/**
 * Wires the session-recall engine (D-044) to this host's live state: the current session view
 * (its log, project, and latest fold boundary, so recall searches the compacted-away span but not
 * the active-prompt tail), a read-only sibling reader over the same transport, and the reasoning
 * provider. Done once at startup; the engine reads through these closures at recall time.
 */
function configureRecall(): void {
  recallEngine.configure({
    current: () => ({
      sessionId: SESSION_ID,
      label: currentLabel(),
      project: projectName(WORKSPACE_ROOT),
      events: conversationLog.eventsSnapshot(),
      foldThroughSeq: compactionController.lastFold?.throughSeq ?? null,
    }),
    siblings: createSiblingReader({
      transport,
      // A passive viewer identity (web runtime kind), so reading a sibling never registers this
      // host as a live host presence on that session.
      identity: viewerIdentity({
        displayName: "trevor-recall",
        instanceId: INSTANCE_ID,
        participantId: recallProducerId(PRODUCER_ID),
      }),
      currentSessionId: SESSION_ID,
      currentWorkspace: abbrevHome(WORKSPACE_ROOT),
      currentProject: projectName(WORKSPACE_ROOT),
    }),
    provider: () => compactionController.providerOrDefault() ?? null,
  });
}

/** Connects to the session stream (replay-then-tail) with simple reconnect. */
function connect(): void {
  live = false;
  mainWorker.connect();
}

// Ctrl-C (SIGINT) is a quick exit: tear down child processes (dev servers, watchers) so they aren't
// orphaned, then go. No turn bookkeeping - an interactive Ctrl-C wants out now.
process.once("SIGINT", () => {
  releaseWorkspaceCwdLock();
  supervisor.killAll();
  // Best-effort MCP teardown (plan 23 M7): close() ends every connected stdio child's stdin
  // synchronously before the first await, and a child orphaned by the exit sees pipe EOF anyway.
  void mcpRuntime.close();
  // Same discipline for the LSP manager (plan 24 M3): language-server children see stdin EOF on
  // a hard exit regardless, so this close is best-effort courtesy, not a correctness gate.
  void lspManager.close();
  process.exit(0);
});

// `trevor stop` sends SIGTERM: a GRACEFUL session shutdown (D-094 M5), distinct from cancel (which
// only aborts the active turn and stays attached) and kill (SIGKILL, no in-process orchestration).
// Abort active work - a clean cancelled completion where it can still flush; a successor leader's
// orphan-reap closes it durably otherwise - clear the deferred queue so no successor answers stale
// prompts, and tear down background jobs. Exiting then lapses the lease (a standby takes over) and
// lets the launcher reap the ownership record. The durable log is never touched.
process.once("SIGTERM", () => {
  try {
    const outcome = performGracefulStop();
    log("host", "stopping (SIGTERM)", {
      cancelledActive: outcome.cancelledActive,
      clearedQueued: outcome.clearedQueued,
    });
  } catch (error) {
    warn("host", "graceful stop failed; tearing down anyway", { error: msg(error) });
    supervisor.killAll();
  }
  void mcpRuntime.close();
  void lspManager.close();
  process.exit(0);
});

configureRecall();
// Tangent adoption poll (plan 37 takeover): while the live leader, rediscover this session's tangents
// (the inventory read model) every few seconds and reconcile a worker for each, so a tangent created
// after go-live is picked up without a restart. `reconcileTangents` self-gates on live+leader (a
// standby tears its workers down), and `.unref()` keeps this timer from holding the process open.
const TANGENT_POLL_MS = 4_000;
setInterval(() => {
  void reconcileTangents();
}, TANGENT_POLL_MS).unref();
// Kick the async source/catalog load (D-065); it re-announces host.online once the live model lists
// are in. Fire-and-forget - the host comes up immediately with empty sources, then fills them in.
refreshCatalog();
log("host", "starting", {
  participant: PARTICIPANT_ID,
  session: SESSION_ID,
  providers: Object.keys(providers).join(","),
  default: DEFAULT_PROVIDER,
});
// Retry the initial ensureSession through a not-yet-ready store (the pnpm-dev startup race,
// a transient blip) instead of exiting on the first "fetch failed" - matching the reconnect
// resilience connect() already has for the live stream.
ensureSessionWithRetry(() => transport.ensureSession(SESSION_ID), {
  onRetry: (attempt, error) =>
    warn("host", "session not ready; retrying", { attempt, error: msg(error) }),
})
  .then(() => connect())
  .catch((error) => {
    warn("host", "startup failed", { error: msg(error) });
    process.exit(1);
  });
