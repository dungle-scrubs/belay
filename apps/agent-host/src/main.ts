import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { publishTurn } from "@host/agent/turn";
import { envNumber } from "@host/boot/env";
import { abbrevHome, TREVOR_STATE_HOME, WORKSPACE_ROOT } from "@host/boot/paths";
import { ensureSessionWithRetry } from "@host/boot/startup";
import { buildCommandRegistry } from "@host/commands/commands";
import { debugCommandSpecs, isStopConfirmed } from "@host/commands/debug-commands";
import { parseHandoff } from "@host/handoff/handoff";
import {
  type DirectHandoffDeps,
  executeFinalizedHandoff,
  runDirectHandoff,
} from "@host/handoff/handoff-flow";
import { generateHandoffPrompt, hasGenerableContext } from "@host/handoff/handoff-generate";
import { BUILTIN_STYLES, buildStyleMenu, DEFAULT_STYLE_ID } from "@host/prefs/styles";
import { vimEnabled } from "@host/prefs/vim-store";
import { supervisor } from "@host/processes/processes";
import { contextRegistry } from "@host/project-context/registry";
import {
  buildControlTurns,
  controlPromptModel,
  controlPromptProvider,
} from "@host/session/control-model";
import {
  acquireCwdLock,
  CWD_LOCK_HEARTBEAT_MS,
  type CwdLockOwner,
  cwdSwitchConflict,
  nodeCwdLockCaps,
  refreshCwdLock,
  releaseCwdLock,
} from "@host/session/cwd-lock";
import { Lease } from "@host/session/lease";
import {
  MAX_RESTART_RESUMES,
  resumeAfterStop,
  type StopOutcome,
  stopSession,
} from "@host/session/session-lifecycle";
import { resolveCdTarget } from "@host/session/workspace-switch";
import { skillRegistry } from "@host/skills/skills";
import { describeAgent, discoverAgents } from "@host/subagents/discovery";
import { CLIPBOARD_TOOL_NAMES, copyLastCopyable, routeClip } from "@host/tools/clip";
import { taskRegistry } from "@host/tools/tasks/tasks";
import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import { Emit } from "@host/transport/services";
import { nodeGitRunner, readGitStatus } from "@host/worktrees/git-status";
import * as Sentry from "@sentry/node";
import {
  type ArtifactRef,
  catalogEntryFor,
  DEFAULT_SESSION_ID,
  decodeTrevorEvent,
  events,
  freshSessionId,
  type GitStatus,
  gitRefLabel,
  inputEstimateTokens,
  type ModelRef,
  PRODUCER_IDS,
  type PublishInput,
  RUNTIME_KIND,
  resolveUserTurnModel,
  type SessionEvent,
  streamTransport,
  type TrevorEventInput,
} from "@trevor/session";
import { serviceUrl } from "@trevor/session/ports";
import { resolveTelemetryConfig } from "@trevor/session/telemetry";
import { createTelemetrySink } from "@trevor/session/telemetry-file-sink";
import { createProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import { capacityResolver, loadAdmissionConfig } from "./admission/config";
import { createLocalAdmissionGate } from "./admission/service";
import { ADMISSION_HEARTBEAT_MS, nodeAdmissionCaps } from "./admission/store";
import { CompactionController } from "./agent/compaction-controller";
import {
  type BackgroundChildInfo,
  type BackgroundDelegator,
  buildDelegateCapability,
  MAX_BACKGROUND_CHILDREN_PER_SESSION,
  runDelegatedChild,
} from "./agent/delegate";
import { buildHistory } from "./agent/history-projection";
import { providerQuestionRuntime } from "./agent/provider-questions";
import { recallEngine } from "./agent/recall/engine";
import { createSiblingReader } from "./agent/recall/reader";
import {
  CONTINUATION_PREFIX,
  lastUserPrompt,
  RESTART_RESUME_REASON,
  resumeProjection,
} from "./agent/resume-projection";
import { createSwitchCell, type SwitchCell } from "./agent/switch-cell";
import { TurnMachine } from "./agent/turn-machine";
import { type ActiveTurn, isAnswerablePrompt, TurnScheduler } from "./agent/turn-scheduler";
import { defaultProbeTargets, nodeProbeIo } from "./connectivity/node-io";
import { InternetMonitor, probeInternet } from "./connectivity/probe";
import { buildLiveDoctorSnapshot, collectDoctorProbeResults } from "./doctor/build";
import { commas, makeHostFacts } from "./doctor/host-facts";
import { currentDoctorSnapshot, registerDoctorSnapshotSource } from "./doctor/source";
import { createLoopPersistence } from "./loop/persistence";
import { createLoopIterationRunner, defaultProcessSeam } from "./loop/runner";
import { LoopStore } from "./loop/store";
import { assembleManifest } from "./manifest/build";
import { registerManifestSource } from "./manifest/source";
import {
  buildProviders,
  type ChatMessage,
  DEFAULT_PROVIDER,
  lmsBin,
  type ProviderError,
  pickProvider,
} from "./providers";
import { buildSourceProvider, type CatalogSnapshot, loadCatalog } from "./providers/catalog";
import { parseOverflowWindow } from "./providers/error-classifier";
import { recordLearnedWindow } from "./providers/model-metadata-overrides";
import { runSourceSignIn, SOURCE_AUTH_PATH, signInTargetFor } from "./providers/provider-auth";
import { createHostResidency } from "./residency/host";
import { disposeCurrentPlan, serialNext } from "./serial-run/driver";
import { startSerialRun } from "./serial-run/entry";
import {
  nodeLoadSerialRun,
  nodeSerialControllerCaps,
  nodeSerialRunStartDeps,
} from "./serial-run/node";
import { bootstrapNodeSentry } from "./telemetry/sentry";
import { registerToolScriptSink } from "./tool-script/sink";
import { READ_ONLY_TOOLS, TOOL_DEFS } from "./tools";
import { getClipboardWriter } from "./tools/clipboard";
import { openInEditor } from "./tools/open-editor";
import { DEFAULT_PROMOTION_CONFIG } from "./tools/promote-policy";
import { promotedResultText, runPromotable } from "./tools/promote-runner";
import { nodeWorktreeManager } from "./worktrees";

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
 * RICHTER_URL to opt into Richter instead. Either way the loop below depends only on
 * the contract, not on a backend.
 *
 * Many hosts may share one session (each with a distinct participant id so
 * Richter lets them coexist), but only the lease LEADER answers turns; others
 * stand by and take over if the leader goes quiet (see @host/session/lease).
 *
 * Responsible for: composition root: wiring transport, session lease, command lane, turn dispatch.
 * Not for: new pure logic - behavior lives in the modules this file wires.
 */

const SESSION_ID = process.env.SESSION_ID ?? DEFAULT_SESSION_ID;
const PRODUCER_ID = PRODUCER_IDS.host;
const CONTROL_PRODUCER_ID = `${PRODUCER_ID}:control`;
// Host-issued prompts for a restricted `/clip <request>` turn (plan 06): a distinct control
// producer so `startTurn` narrows the turn's tool surface to clipboard_write only. Answerable
// (not the bare host id), but tagged so it is never treated as a normal full-surface turn.
const CLIP_PRODUCER_ID = `${PRODUCER_ID}:clip`;
// Backend selection (the plugin seam): default to the local session-store; set
// RICHTER_URL to opt into the Richter durable substrate instead. The host speaks
// the SessionTransport contract either way.
const RICHTER_URL = process.env.RICHTER_URL;
const SESSION_STORE_URL = process.env.SESSION_STORE_URL ?? serviceUrl("store");
// Richter speaks the same SessionTransport contract as the local store, so backend selection is just
// which URL the stream transport points at (no separate adapter until Richter needs real divergence).
const transport = streamTransport(RICHTER_URL ?? SESSION_STORE_URL);
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
const commands = buildCommandRegistry();
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

// Host-driven source SIGN-IN (D-065 M5): the chooser's authenticate/re-authenticate action asks the
// host to run an OAuth device-code flow. The host emits the device code (URL + short code), waits for
// the user to authorize, persists the credential, and refreshes the catalog so the source flips to
// ready. One flow at a time - a new sign-in (or a cancel) aborts the in-flight one.
let signInAbort: AbortController | null = null;
// The browser+paste flow (Anthropic) awaits a user-pasted code; `/source-signin-code` resolves this.
let signInCodeResolver: ((code: string) => void) | null = null;
function startSourceSignIn(sourceId: string): void {
  const target = signInTargetFor(sourceId);
  if (!target) {
    void emit(
      events.hostSourceAuth({
        state: { sourceId, phase: "error", detail: "this source has no sign-in flow" },
      }),
    );
    return;
  }
  signInAbort?.abort();
  const controller = new AbortController();
  signInAbort = controller;
  let completed = false;
  void runSourceSignIn({
    sourceId,
    oauthName: target.oauthName,
    login: target.login,
    authPath: SOURCE_AUTH_PATH,
    signal: controller.signal,
    emit: (state) => {
      if (state.phase === "complete") {
        completed = true;
      }
      void emit(events.hostSourceAuth({ state }));
    },
    // Browser+paste flow: hold the resolver until `/source-signin-code` arrives; reject on abort so
    // the login unwinds to a cancelled phase.
    requestCode: () =>
      new Promise<string>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signInCodeResolver = resolve;
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  }).then(() => {
    if (signInAbort === controller) {
      signInAbort = null;
    }
    signInCodeResolver = null;
    // Re-read auth only on success: the new credential makes the source ready in the next catalog.
    if (completed) {
      refreshCatalog();
    }
  });
}
// Trevor-managed worktrees (D-091): the registry+git manager, rooted at TREVOR_STATE_HOME, with the
// shared home-abbreviation as its display closure.
const worktrees = nodeWorktreeManager(abbrevHome);

// Debug mode: a runtime flag (booted from `TREVOR_DEBUG`, set by `trevor --debug`, toggled at
// runtime by `/debug`) that gates a collection of dev-only host commands - hidden from a normal
// session. `/restart` re-execs the host to pick up code changes on demand; `/archive`, `/unarchive`,
// and `/stop` are the debug lifecycle controls (D-094 M4). The gated set + the `/stop` confirm live in
// debug-commands.ts (pure, unit-tested); the handlers stay here (they touch the live host state).
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
/** The prompt projection: `history === buildHistory(historyEvents)` at every turn boundary. The
 *  event log is what the host folds (now including the turn's tool.started/tool.completed, which
 *  buildHistory carries across turns). A deferred mid-turn prompt is admitted only when it drains
 *  (the scheduler defers it out of the log), so the projection stays strictly paired. Tool events
 *  are RECORDED (pushed) but not re-projected per call - `history` is only read at turn boundaries,
 *  where the next admit rebuilds with them - so a tool-heavy turn doesn't re-fold the whole log on
 *  every call. */
let history: ChatMessage[] = [];
let historyEvents: SessionEvent[] = [];
let leaseRunning = false;
// The turn-dispatch state (active run, deferred FIFO, catch-up watermarks) lives in
// the TurnScheduler constructed below, not in module mutables.

/** Publishes one event to the durable log, attaching this host's producerId. */
function emit(event: TrevorEventInput): Promise<void> {
  return transport.publishEvent(SESSION_ID, { ...event, producerId: PRODUCER_ID });
}

// The ask_user pending-question runtime publishes its request/resolved events through this host's emit
// (fire-and-forget). The blocking + answer routing live in the runtime; main.ts only wires the boundary.
providerQuestionRuntime.configure((event) => {
  void emit(event);
});

const turnMachine = new TurnMachine();
const compactionController = new CompactionController(providers[DEFAULT_PROVIDER]);

/**
 * The run this host is ACTIVELY executing (its turn fiber is alive), or null. Set when a turn forks and
 * cleared when its fiber exits, so the reconnect reconcile (`reapOrphans` from `goLive`) can tell a
 * genuinely-live turn from an orphan whose terminal completion was lost to a store outage.
 */
let runningRunId: string | null = null;

/**
 * The active turn's mid-turn-switch cell (plan 09.1), keyed by its runId. `startTurn` sets it when a
 * switchable turn forks; the fiber observer clears it. `handleEvent` writes a `model.switch.requested`
 * into it so the loop re-resolves model+reasoning at its next step boundary. Null when no switchable
 * turn is in flight, so a switch request with no active turn is a loop no-op (the web keeps its
 * next-turn selection - today's behavior).
 */
let activeSwitch: { readonly runId: string; readonly cell: SwitchCell } | null = null;

/** The live Emit service: the turn program's events go to the Richter log via emit(). A second
 *  assistant.completed for an already-completed run (the fiber's onExit racing the immediate cancel)
 *  is dropped. */
const EmitLive = Layer.succeed(Emit, {
  publish: (event) =>
    Effect.promise(() => {
      if (event.type === "assistant.completed") {
        const runId = typeof event.payload.runId === "string" ? event.payload.runId : "";
        if (runId) {
          if (!turnMachine.markCompleted(runId)) {
            return Promise.resolve();
          }
        }
      }
      return emit(event);
    }),
});

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

/** Lease timings are overridable via env so tests can run fast. */
function leaseOptions() {
  return {
    heartbeatMs: envNumber("LEASE_HEARTBEAT_MS"),
    probeMs: envNumber("LEASE_PROBE_MS"),
    ttlMs: envNumber("LEASE_TTL_MS"),
    settleMs: envNumber("LEASE_SETTLE_MS"),
  };
}

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
      }
    },
  },
  leaseOptions(),
);

/**
 * Forks the agent turn for a user.message and returns its handle for the scheduler to
 * track, or null when this host should not answer it (self-authored, not the leader, or
 * not a user.message). One fiber per turn: cancelling it (ESC in the browser) tears down
 * the in-flight provider stream and publishes the cancelled completion. The fiber
 * observer is a backstop that frees the scheduler's slot if the fiber dies without a
 * completion event; the scheduler structurally guarantees one turn at a time, so there
 * is no "already active" case to guard here.
 */
function startTurn(event: SessionEvent, turnHistory: readonly ChatMessage[]): ActiveTurn | null {
  if (!isAnswerablePrompt(event.producerId, PRODUCER_ID) || !lease.isLeader()) {
    return null;
  }
  const decoded = decodeTrevorEvent(event);
  if (decoded?.type !== "user.message") {
    return null;
  }
  const runId = crypto.randomUUID();
  // Resolve the turn's source + reasoning through the migration bridge (D-065): a new event's
  // `model` ModelRef wins (its sourceId is the provider key, its reasoning is authoritative), else
  // the legacy provider/reasoning strings. pickProvider defaults an unknown/undefined source.
  const turnModel = resolveUserTurnModel(decoded);
  // Resolve the turn's provider (D-065): a ModelRef into a known catalog SOURCE builds a provider for
  // that exact model (so any catalog model runs, not just the ~6 registered keys); otherwise fall back
  // to the legacy registered providers keyed by the provider string. pickProvider defaults an unknown.
  const provider =
    (decoded.model ? buildSourceProvider(decoded.model.sourceId, decoded.model.modelId) : null) ??
    pickProvider(providers, turnModel.sourceId);
  // Remember the turn's provider so a between-turn fold summarizes with the same model (D-043).
  compactionController.noteProvider(provider);
  // Reconcile local-model residency for this turn's provider (plan 11.1): claim the local model it holds
  // (releasing + sweeping the prior one), or release the current claim when the turn goes to the cloud.
  // Fire-and-forget: residency is best-effort and must never gate a turn.
  void residency.onActiveModelChanged(provider.residencyTarget?.() ?? null);
  // A cloud turn may want fresh connectivity for the advisory (D-060): refresh if stale, never block
  // the turn on it (fire-and-forget; the result rides a later host.internet).
  if (provider.kind === "cloud") {
    void internet.refreshIfStale();
  }
  // The delegation capability for this PARENT turn (D-048): it can hand a subtask to a discovered
  // subagent, which runs in its own isolated child session and folds its distilled result back.
  // A child turn (run inside runDelegatedChild) is given no capability, so depth stays 1.
  const delegationCtx = {
    transport,
    parentSessionId: SESSION_ID,
    producerId: PRODUCER_ID,
    mintChildSessionId: () => `${SESSION_ID}::sub::${crypto.randomUUID()}`,
  };
  // The host owns the background lifecycle: a background child OUTLIVES this turn, so it runs detached
  // here against the SESSION-level registry + cap, publishing its terminal delegated.to to the parent
  // log whenever it finishes (the parent turn's fiber may be long gone). runDelegatedChild never throws.
  const background: BackgroundDelegator = {
    cap: MAX_BACKGROUND_CHILDREN_PER_SESSION,
    canStart: () => backgroundChildren.size < MAX_BACKGROUND_CHILDREN_PER_SESSION,
    start: (req) => {
      backgroundChildren.set(req.childRunId, {
        childRunId: req.childRunId,
        childSessionId: req.childSessionId ?? "",
        agent: req.agent.id,
        task: req.task,
      });
      void runDelegatedChild(delegationCtx, req).finally(() =>
        backgroundChildren.delete(req.childRunId),
      );
    },
  };
  // A restricted `/clip <request>` turn (plan 06): narrow the surface to clipboard_write only and
  // withhold delegation entirely, so the model can neither see another tool nor hand work to a
  // subagent that could. A normal turn gets the full registry + delegation.
  const restricted = event.producerId === CLIP_PRODUCER_ID;
  const delegate = restricted
    ? undefined
    : buildDelegateCapability(delegationCtx, {
        provider,
        parentRunId: runId,
        agents: discoverAgents(),
        mintRunId: () => crypto.randomUUID(),
        background,
      });
  runningRunId = runId;
  // The per-turn mid-turn-switch cell (09.1): a `/clip` turn is not switchable (restricted surface), an
  // ordinary turn is. Registered so `handleEvent` can route a `model.switch.requested` for this run into
  // it; the loop reads it at the next step boundary.
  const switchCell = restricted ? undefined : createSwitchCell();
  activeSwitch = switchCell ? { runId, cell: switchCell } : null;
  // Carry the prior turn's measured context forward (03.1 D-002): when compaction has floored out and
  // the turn legitimately starts at/above the fraction, this lets the context-pressure gate synthesize
  // at step 0 instead of opening one doomed tool round. Absent on a session's first turn.
  const seedUsage = compactionController.usageSeed();
  const fiber = Effect.runFork(
    publishTurn(provider, turnHistory, {
      runId,
      reasoning: decoded.reasoning,
      delegate,
      telemetry: hostTelemetry,
      providerTrace,
      ...(restricted ? { toolNames: CLIPBOARD_TOOL_NAMES } : {}),
      ...(seedUsage ? { seedUsage } : {}),
      ...(switchCell ? { switch: switchCell } : {}),
      // Resolve a mid-turn model switch to a fresh provider (09.1 M4): same source builder used to build
      // the turn's initial provider, so any catalog model can be swapped to mid-flight.
      ...(switchCell
        ? {
            rebuildProvider: (model: ModelRef) =>
              buildSourceProvider(model.sourceId, model.modelId),
          }
        : {}),
      // The turn's starting ref (when it carried one) seeds the same-model check, so a reasoning-only
      // re-send of the unchanged model does not pointlessly rebuild the provider.
      ...(switchCell && decoded.model ? { initialModel: decoded.model } : {}),
    }).pipe(Effect.provide(EmitLive)),
  );
  fiber.addObserver((exit) => {
    // The fiber is no longer running this turn: clear the active marker so a reconnect reconcile treats
    // a lingering in-flight entry for it as an orphan (its terminal completion may have been lost).
    if (runningRunId === runId) {
      runningRunId = null;
    }
    // Drop the switch cell for this run so a late switch request can't write into a dead turn.
    if (activeSwitch?.runId === runId) {
      activeSwitch = null;
    }
    // publishTurn handles provider failures internally, so a non-interrupt failure here
    // is an unexpected defect worth surfacing.
    if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
      warn("host", "turn died", { run: runId.slice(0, 8), cause: Cause.pretty(exit.cause) });
    }
    scheduler.settle(runId);
  });
  return {
    runId,
    cancel: () => {
      log("host", "cancel: interrupting run", { run: runId.slice(0, 8) });
      Effect.runFork(Fiber.interrupt(fiber));
    },
  };
}

/**
 * The turn machine: owns when turns run (one at a time, deferred FIFO, leader catch-up).
 * Each prompt is recorded through `start`, which admits it to the prompt view and - only
 * when this host is the live leader - forks its turn. On replay the prompt is recorded
 * without being answered.
 */
// --- cross-turn compaction (D-040..D-043) ---
// The latest turn's prompt size + window, captured from each assistant.completed usage, drive the
// between-turn compaction gate (the within-turn airbag is overflow recovery). `floorReached` stops
// retrying a fold that could not shrink further until a fresh turn moves the needle; `lastProvider`
// is the model the fold summarizes with (the last turn's provider, per D-043).
/** The in-flight MANUAL `/compact` fold, so ESC can interrupt it (the user asked, so they can take
 *  it back). Only the manual fold is tracked - automatic folds are not interruptible (the blocking
 *  one is load-bearing for the next turn). Null when no manual fold is running. */
let manualCompactFiber: Fiber.RuntimeFiber<TrevorEventInput | null, ProviderError> | null = null;
/** True between a `/compact` command and its `command.result`. If a host dies mid-fold the command
 *  is left with no result (a dangling `/compact` that looks broken); the next leader gives it one. */
let compactPending = false;
const autoContinuedRuns = new Set<string>();

/** Background subagents currently running across the session (Phase 5 / D-048), keyed by child run id.
 *  Each OUTLIVES the parent turn that started it - the registry is session-level, not per-turn - so the
 *  cap holds across turns and /doctor can report active children. An entry clears when the child settles. */
const backgroundChildren = new Map<string, BackgroundChildInfo>();

function controlProvider(): string {
  return compactionController.providerOrDefault()?.id ?? DEFAULT_PROVIDER;
}

/**
 * The provider + model a host-issued control prompt (auto-continue after a step-cap pause, retry,
 * compact-then-continue, handoff) resolves to, resolved in three tiers newest-first so a resumed turn
 * keeps the model it was actually running on:
 *   1. the most recent turn's explicit catalog ModelRef (round-trips its source/model), else
 *   2. the most recent REAL user turn's legacy provider string - skipping the host's own control
 *      prompts so the scan never re-inherits the compaction provider (the 02.13 fix), else
 *   3. the compaction/default provider - only a session with no real user turn yet.
 * Without tier 2 a legacy provider-string-only turn (a source id that does not round-trip through
 * `pickProvider`) silently downgraded to the host's LOCAL default model. The one resolver every
 * continuation/retry/handoff path shares.
 */
function controlModel(): { readonly provider: string; readonly model: ModelRef | undefined } {
  const turns = buildControlTurns(historyEvents, CONTROL_PRODUCER_ID);
  return {
    provider: controlPromptProvider(turns) ?? controlProvider(),
    model: controlPromptModel(turns),
  };
}

/**
 * The producer-tagged `user.message` for a host-issued control prompt: the control producer id (the
 * turn-scheduler self-echo contract that keeps a handed-off/continued session from ignoring it), the
 * resolved provider + last-turn model, and the event shape. The ONE owner of the control-prompt shape,
 * so continuation, retry, and handoff can't rebuild it three subtly-different ways. `provider`/`model`
 * default to the live resolution; a retry passes the original prompt's own values.
 */
function controlPromptEvent(over: {
  readonly text: string;
  readonly provider?: string;
  readonly model?: ModelRef;
  readonly reasoning?: string;
  readonly artifacts?: readonly ArtifactRef[];
}): PublishInput {
  const resolved = controlModel();
  return {
    ...events.userMessage({
      text: over.text,
      provider: over.provider ?? resolved.provider,
      model: over.model ?? resolved.model,
      reasoning: over.reasoning,
      artifacts: over.artifacts,
    }),
    producerId: CONTROL_PRODUCER_ID,
  };
}

async function publishControlPrompt(text: string, provider = controlProvider()): Promise<void> {
  await transport.publishEvent(SESSION_ID, controlPromptEvent({ text, provider }));
}

/** The prefix every continuation prompt shares; used to recognise a turn that is itself a continuation
 *  (so a step-budget pause is not auto-stacked). */
async function continueAfterStop(reason: string): Promise<void> {
  await publishControlPrompt(
    `${CONTINUATION_PREFIX} Reason: ${reason}. Do not repeat completed work; proceed from the current transcript and finish the user's request.`,
  );
}

async function retryLastPrompt(): Promise<{ readonly ok: boolean; readonly text: string }> {
  const last = lastUserPrompt(historyEvents);
  if (!last) {
    return { ok: false, text: "No prior user prompt to retry." };
  }
  await transport.publishEvent(
    SESSION_ID,
    controlPromptEvent({
      text: last.text,
      provider: last.provider,
      model: last.model,
      reasoning: last.reasoning,
      artifacts: last.artifacts,
    }),
  );
  return { ok: true, text: "Retrying the last user prompt." };
}

/**
 * The producer-tagged `user.message` that drives a restricted `/clip <request>` turn (plan 06):
 * the clip control producer (so `startTurn` narrows the surface to clipboard_write), the resolved
 * provider + last-turn model, and the framed clip prompt as the turn's user text.
 */
function clipPromptEvent(text: string): PublishInput {
  const resolved = controlModel();
  return {
    ...events.userMessage({ text, provider: resolved.provider, model: resolved.model }),
    producerId: CLIP_PRODUCER_ID,
  };
}

/**
 * The `/clip` command lane (plan 06). Bare `/clip` copies the last copyable transcript item through
 * the host clipboard abstraction and answers with a visible command.result - NO model turn. `/clip
 * <request>` publishes a clip-producer prompt that the turn machine runs as a restricted
 * clipboard-only turn. Only the live leader reaches here.
 */
async function runClip(args: string): Promise<void> {
  const route = routeClip(args);
  if (route.kind === "copy") {
    const result = await copyLastCopyable(history, getClipboardWriter());
    await emit(events.commandResult({ command: "/clip", text: result.text, ok: result.ok }));
    return;
  }
  await transport.publishEvent(SESSION_ID, clipPromptEvent(route.prompt));
}

async function compressThenContinue(): Promise<{ readonly ok: boolean; readonly text: string }> {
  const compacted = await forceCompact();
  if (
    compacted.startsWith("A turn is in progress") ||
    compacted.startsWith("A compaction is already running") ||
    compacted.startsWith("No provider available") ||
    compacted.startsWith("Compaction failed")
  ) {
    return { ok: false, text: compacted };
  }
  await continueAfterStop(`context was compacted first: ${compacted}`);
  return { ok: true, text: `${compacted}\nContinuing after compaction.` };
}

/**
 * Auto-resume the trailing turn when the log shows it stopped without finishing the user's request: a
 * host-restart interrupt (this host reaped it, or the browser recovered the orphan while no host was up)
 * is re-issued from the transcript, bounded to {@link MAX_RESTART_RESUMES} consecutive resumes before
 * falling back to a manual Resume so a crash-looping host cannot spin; a step-budget pause keeps the
 * existing auto-continue. Idempotent per run via `autoContinuedRuns`; callers gate it on live + leader,
 * so replay and standbys never fire. The decision is read from the durable log (not in-memory counters),
 * so the crash-loop bound survives the very restarts it guards.
 */
function maybeAutoResume(): void {
  const { turn, inputs } = resumeProjection(historyEvents);
  if (!turn || !inputs || turn.continued || autoContinuedRuns.has(turn.runId)) {
    return;
  }
  const decision = resumeAfterStop(inputs);
  if (decision.kind === "none") {
    return;
  }
  autoContinuedRuns.add(turn.runId);
  if (decision.kind === "manual") {
    warn("host", "auto-resume exhausted; awaiting manual Resume", {
      run: turn.runId.slice(0, 8),
      after: MAX_RESTART_RESUMES,
    });
    return;
  }
  const reason =
    decision.cause === "restart"
      ? RESTART_RESUME_REASON
      : (turn.stopSummary ?? turnMachine.lastTermination ?? "turn paused");
  // Surface the resolved provider/model so a resume DOWNGRADE (a real turn provider that fell through
  // to the local default) is visible in host logs / debug, not silent. <!-- 02.13 -->
  const resolved = controlModel();
  log("host", "auto-resuming turn", {
    run: turn.runId.slice(0, 8),
    cause: decision.cause,
    ...(decision.cause === "restart" ? { attempt: decision.attempt } : {}),
    provider: resolved.provider,
    model: resolved.model ? `${resolved.model.sourceId}/${resolved.model.modelId}` : undefined,
  });
  continueAfterStop(reason).catch((error) =>
    warn("host", "auto-resume failed", { run: turn.runId.slice(0, 8), error: msg(error) }),
  );
}

/**
 * Publishes the terminal completion for a run being closed WITHOUT a completion of its own - a user
 * cancel (ESC) or a host reap of an orphan. Dedups via `completedRuns` (the fiber's own onExit is
 * dropped, so the run closes exactly once) and carries the run's last-known usage, since the tokens
 * it consumed don't vanish on a cancel. `cancelled` = the user pressed ESC; `interrupted` = the host
 * closed it (restart/crash mid-turn), rendered as a muted "host restarted" note rather than an ESC.
 */
function closeRun(runId: string, kind: "cancelled" | "interrupted"): void {
  const event = turnMachine.close(runId, kind);
  if (event) {
    emit(event).catch(() => {});
  }
}

/**
 * Tears down the active work for a cancel/stop: interrupt a running MANUAL /compact (the user asked,
 * so they can take it back; automatic folds aren't tracked here and run to completion), close every
 * targeted run as `cancelled`, and cancel the scheduler. An empty `runId` means "whatever is active" -
 * every in-flight run - and matches `scheduler.cancel("")`. Shared by the live-leader user.cancel
 * handler and the graceful-stop path, so /stop + SIGTERM tear down the same things ESC does.
 */
function abortRuns(runId: string): void {
  if (manualCompactFiber) {
    Effect.runFork(Fiber.interrupt(manualCompactFiber));
  }
  const targets = runId ? [runId] : turnMachine.inFlightIds();
  for (const target of targets) {
    closeRun(target, "cancelled");
  }
  scheduler.cancel(runId);
}

/**
 * Closes runs left dangling by a previous leader (crashed or hot-reloaded mid-turn): an
 * assistant.started with no completion. Called on TAKING leadership, when this host has no turn of
 * its own running, so every in-flight run is a dead orphan. Closes each as `interrupted`, which
 * unfreezes the send queue and makes ESC meaningful again on the next real turn. Idempotent: each
 * emitted completion echoes back and the set is cleared.
 */
function reapOrphans(): void {
  for (const event of turnMachine.reapExcept(runningRunId)) {
    const runId = typeof event.payload.runId === "string" ? event.payload.runId : "";
    log("host", "reaping orphaned run", { run: runId.slice(0, 8) });
    // Emit directly (not via closeRun's dedup gate): a turn whose completion was lost to a store outage
    // already tripped that gate, so going through it again would silently drop the reconciling event.
    emit(event).catch(() => {});
  }
}

/** Emit at most one progress tick per this many summary tokens, so a streaming fold publishes a
 *  bounded handful of advisory `context.compacting` events rather than one per delta. */
const COMPACT_PROGRESS_TOKEN_STEP = 40;

/** Builds a throttled progress callback for one fold: emits an honest live `context.compacting`
 *  tick (real tokens streamed ÷ budget) as the summary streams, fire-and-forget. The web fills a
 *  transient bar from these and drops it when the matching `context.compacted` lands. */
function compactionProgress(foldId: string): (tokens: number, budget: number) => void {
  // -1 = nothing emitted yet (so the first tick always fires, even at 0). A plain 0 sentinel breaks
  // the throttle while the summary sits at 0 tokens - the model ingesting a large fold prompt before
  // its first output token - flooding the log with identical tokens:0 ticks.
  let lastEmitted = -1;
  return (tokens, budget) => {
    if (lastEmitted >= 0 && tokens - lastEmitted < COMPACT_PROGRESS_TOKEN_STEP) {
      return;
    }
    lastEmitted = tokens;
    emit(events.contextCompacting({ foldId, tokens, budget })).catch(() => {});
  };
}

/** True when a fold should run before the next turn: live leader, over COMPACT_WHEN of the window,
 *  and not already at the fold floor. Live + leader gated so replay/standbys never gate (a fold that
 *  cannot change the budget there would loop the scheduler). */
function needsCompaction(): boolean {
  return compactionController.needed(live && lease.isLeader());
}

/**
 * Kicks off ONE fold off the idle slot: plan + summarize + emit `context.compacted`. The fold's own
 * echo (handled below) admits it, updates the budget estimate, and releases the gate. A no-fold
 * result (nothing left to fold) or any failure marks the floor and releases the gate directly, so
 * the gate never loops. Not live/leader (or no provider) just releases the gate.
 */
function startCompaction(): void {
  const provider = compactionController.providerOrDefault();
  if (!live || !lease.isLeader() || !provider) {
    scheduler.finishCompaction();
    return;
  }
  const foldId = crypto.randomUUID();
  Effect.runFork(
    compactionController
      .planFold({
        provider,
        events: historyEvents.slice(),
        producerId: PRODUCER_ID,
        foldId,
        onProgress: compactionProgress(foldId),
      })
      .pipe(
        Effect.flatMap((event) =>
          event
            ? // Its echo (the context.compacted case in handleEvent) admits it + releases the gate.
              Effect.promise(() => emit(event))
            : Effect.sync(() => {
                compactionController.markFloorReached();
                scheduler.finishCompaction();
              }),
        ),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            warn("host", "compaction failed", { cause: Cause.pretty(cause) });
            compactionController.markFloorReached();
            scheduler.finishCompaction();
          }),
        ),
      ),
  );
}

const scheduler = new TurnScheduler({
  isLeader: () => lease.isLeader(),
  start: (event) => {
    admit(event);
    return live ? startTurn(event, history.slice()) : null;
  },
  compaction: { needed: needsCompaction, run: startCompaction },
});

/** On becoming leader: answer any pending prompt, else pre-warm the local model. */
function onBecomeLeader(): void {
  // Claim the cwd advisory lock now that we are the mutating owner of this directory (plan 01).
  acquireWorkspaceCwdLock();
  // The leader owns the internet probe (D-060): kick off a fresh check + re-announce so the advisory
  // reflects this host's reachability. Fire-and-forget - a turn never waits on it.
  internet
    .refresh()
    .then(announceOnline)
    .catch(() => {});
  if (turnMachine.hasInFlight) {
    // A previous leader left turns dangling (crashed / hot-reloaded mid-turn). Close them so every
    // client stops reading them as active (unfreezes the send queue, makes ESC meaningful), and drop
    // the stale pending prompt. Each reap's interrupted completion echoes back to the completion handler,
    // which auto-resumes it from the transcript (bounded) - so the work continues instead of stranding
    // the user mid-turn, while a user ESC (cancelled, not interrupted) still stays put.
    reapOrphans();
    scheduler.clearPending();
  } else if (live) {
    // No dangling run, but the trailing turn may be an un-continued interrupt a prior host never
    // resumed (e.g. the browser recovered the orphan, then this host took leadership while already
    // live - the path goLive's post-replay reconcile doesn't re-run). Pick it up.
    maybeAutoResume();
  }
  // A /compact whose fold a previous leader was interrupted mid-run (restart/crash) left its command
  // with no result - a dangling "/compact" that looks broken. Give it one. `!manualCompactFiber`
  // guards the (rare) leadership-flap-mid-fold case where this host is the one actually running it.
  if (compactPending && !manualCompactFiber) {
    compactPending = false;
    emit(
      events.commandResult({
        command: "/compact",
        text: "Compaction interrupted — the host restarted. Run /compact again.",
        ok: false,
      }),
    ).catch(() => {});
  }
  const pending = scheduler.pendingCatchUp();
  if (pending) {
    scheduler.noteTurn(pending); // catch up a prompt that arrived while probing
    return;
  }
  const local = providers[DEFAULT_PROVIDER];
  if (!local) {
    return;
  }
  // Pre-warm the local model off the leader transition (best-effort: log and move on).
  Effect.runFork(
    Effect.gen(function* () {
      const { warm } = yield* local.readiness();
      if (!warm) {
        yield* local.warm();
      }
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => warn("host", "warm failed", { cause: Cause.pretty(cause) })),
      ),
    ),
  );
}

/**
 * Reads the host cwd's structured git status (D-088) plus a back-compat `branch` string
 * derived from it (branch name, or `detached <sha>` when HEAD is detached). A non-git cwd
 * yields both undefined - the status is omitted rather than reported as an empty repo.
 */
function currentGit(): { git: GitStatus | undefined; branch: string | undefined } {
  const status = readGitStatus(nodeGitRunner(process.cwd()));
  if (!status) {
    return { git: undefined, branch: undefined };
  }
  return { git: status, branch: gitRefLabel(status) ?? undefined };
}

/**
 * Builds and emits host.online with a freshly-read git status. Idempotent + latching, so
 * it doubles as the git-status refresh after a host-owned operation that can change the
 * repository (a `!` shell command); a `/cd` or `/clear` instead spawns a new host that
 * re-runs goLive in the new cwd.
 */
/** The managed worktrees for the host's current base repo (empty when cwd is not a git repo). */
function currentWorktrees(): ReturnType<typeof worktrees.summaries> {
  try {
    return worktrees.summaries(process.cwd());
  } catch {
    return [];
  }
}

function announceOnline(): void {
  const { git, branch } = currentGit();
  emit(
    events.hostOnline({
      // Per-provider model id + thinking options so the browser can render the right
      // reasoning control (none / binary / graduated) for whichever provider is chosen.
      // Each provider describes its own descriptor, so the announcement can't drift from
      // the Provider interface.
      providers: Object.keys(providers),
      default: DEFAULT_PROVIDER,
      models: Object.fromEntries(
        Object.entries(providers).map(([key, provider]) => [key, provider.describe()]),
      ),
      instanceId: INSTANCE_ID,
      ...(branch ? { branch } : {}),
      ...(git ? { git } : {}),
      cwd: abbrevHome(process.cwd()),
      workspace: abbrevHome(WORKSPACE_ROOT),
      // The immediate-command inventory, so the browser knows which slashes route
      // to the host's command lane (and can drive a slash menu). Debug-mode adds /restart
      // (and friends) to this set; toggling /debug re-announces with the set updated.
      commands: [...commands.specs, ...debugCommandSpecs(debugMode)],
      // The discovered subagents (D-045), so the model picks one to delegate to by description.
      agents: discoverAgents().map(describeAgent),
      // The managed worktrees for this base repo (D-091), so the browser's switcher renders
      // without reading local state.
      worktrees: currentWorktrees(),
      // The latest internet snapshot (D-060), so a joining client sees connectivity without waiting
      // for the next probe transition.
      internet: internet.current(),
      // The host-owned model sources + per-source catalog (D-065): the provider/runtime/subscription
      // summaries with auth state, and each configured source's live model list. Empty until the
      // first async load completes (then a re-announce fills them in).
      sources: catalog.sources,
      catalog: catalog.catalogBySource,
      // The host-owned Vim-mode prompt preference (plan 06), so the web gates its opt-in composer
      // motions on this machine's vim.json config rather than per-tab browser state.
      vimEnabled: vimEnabled(),
      // The tracked background jobs (plan 09): promoted bash/shell commands + `process` jobs, so the
      // support panel renders them. The supervisor re-announces on every job change (below).
      jobs: supervisor.snapshots(),
    }),
  ).catch(() => {});
}

// Re-announce host.online whenever a *visible* tracked job changes (a `process` start or a promoted
// command's start / exit / kill / promote / remove), so the support panel reflects it live without polling
// (plan 09 M7). The supervisor already gates this to visible jobs, so an ordinary foreground command fires
// nothing; each announce is a full host.online snapshot the web folds via latest(), so a re-emit is a
// harmless no-op for consumers (it is not debounced - the gating is what bounds the volume).
supervisor.onChange = announceOnline;

/** On go-live: start the lease (once), announce presence, and report online. */
function goLive(): void {
  log("host", "replay complete; live");
  if (!leaseRunning) {
    leaseRunning = true;
    lease.start(Date.now());
    setInterval(() => lease.tick(Date.now()), 500);
    // Keep the cwd advisory lock's heartbeat fresh while we lead, so a crashed leader's lock ages into
    // stale and is reclaimable (plan 01). Leader-gated, cheap, best-effort.
    setInterval(() => {
      if (lease.isLeader()) {
        try {
          refreshCwdLock(WORKSPACE_ROOT, cwdLockOwner(), cwdLockCaps);
        } catch {
          // best-effort heartbeat
        }
      }
    }, CWD_LOCK_HEARTBEAT_MS);
    // Keep this instance's local-model residency claim fresh so it doesn't age into stale + get
    // reclaimed while we still hold the model (plan 11.1). A no-op when no local model is claimed.
    setInterval(() => {
      void residency.heartbeat();
    }, ADMISSION_HEARTBEAT_MS);
  }
  emit(events.hostHello({ instanceId: INSTANCE_ID })).catch(() => {});
  announceOnline();
  // Reconnect reconcile: a turn that ended while the store was unreachable (a socket/store outage,
  // e.g. a watch-lane restart mid-turn) had its terminal completion lost, leaving it
  // started-with-no-completion in the log - a forever-"Working" phantom. Now that the stream is back,
  // close every such orphan. A genuinely live turn (runningRunId) is excluded, so this never cuts a
  // real turn short. Leader-only: only the owner closes runs. (Cold leadership also reaps via
  // onBecomeLeader; this adds the reconnect-as-existing-leader path that case misses.)
  if (lease.isLeader()) {
    reapOrphans();
    // After reaping, auto-resume an un-continued trailing interrupt that is already settled in the log
    // (the browser recovered the orphan while no host was up - tonight's nimoy/lucid case). A run this
    // reap just closed is still mid-echo, so it is picked up by the completion handler, not here.
    maybeAutoResume();
  }
}

/**
 * Forces one compaction fold now (the /compact command), at ANY context level: `force` folds every
 * completed turn regardless of the budget (the user asked - their choice), not just when over 80%.
 * Same plan + summary + emit path, whose echo admits the fold. Refuses only while a turn is active
 * (a fold must not overlap a turn, D-041), and reports when there's genuinely nothing to fold.
 */
async function forceCompact(): Promise<string> {
  if (scheduler.isBusy()) {
    return "A turn is in progress — run /compact again once it finishes.";
  }
  if (manualCompactFiber) {
    return "A compaction is already running.";
  }
  const provider = compactionController.providerOrDefault();
  if (!provider) {
    return "No provider available to summarize.";
  }
  const foldId = crypto.randomUUID();
  // Forked (not awaited inline) so ESC can interrupt it - the summary's provider stream aborts on
  // interrupt. On interrupt nothing is emitted, so the context is left exactly as it was.
  const fiber = Effect.runFork(
    compactionController.planFold({
      provider,
      events: historyEvents.slice(),
      producerId: PRODUCER_ID,
      foldId,
      onProgress: compactionProgress(foldId),
      force: true, // fold regardless of the current context %
    }),
  );
  manualCompactFiber = fiber;
  const exit = await Effect.runPromise(Fiber.await(fiber));
  manualCompactFiber = null;
  if (Exit.isFailure(exit)) {
    if (Cause.isInterruptedOnly(exit.cause)) {
      return "Compaction cancelled."; // the user pressed ESC; no fold applied
    }
    warn("host", "compaction failed", { cause: Cause.pretty(exit.cause) });
    return "Compaction failed.";
  }
  const event = exit.value;
  if (!event) {
    return "Nothing to compact — no completed turns to fold yet.";
  }
  await emit(event); // the echo admits the fold and updates the budget estimate
  return `✓ compacted ~${commas(Number(event.payload.tokensBefore))} → ~${commas(Number(event.payload.tokensAfter))} tokens`;
}

/**
 * Runs a prompt-shell-lane command (a leading `!`) through the shared protected `runCommand` path and
 * publishes one `shell.result` (paired by requestId). Like an immediate command this bypasses the
 * model and the turn queue and runs even while a turn streams - but unlike a command its output never
 * enters the model context (D-082). A refusal (safety floor) or non-zero/timeout maps to `ok: false`.
 */
async function runShellCommand(requestId: string, command: string): Promise<void> {
  // The prompt-shell lane shares the promotable runner (plan 09): a long `!command` promotes to a tracked
  // background job rather than timing out. The shell.result output stays out of the model context (D-082);
  // a promoted result names its `pN` and is `ok` (it is running, not failed).
  const result = await runPromotable(supervisor, command, process.cwd(), {
    enabled: DEFAULT_PROMOTION_CONFIG.enabled,
    thresholdMs: DEFAULT_PROMOTION_CONFIG.thresholdMs,
    origin: { source: "shell", requestId },
  });
  const output =
    result.decision === "promote"
      ? promotedResultText(result.jobId ?? "?", result.output)
      : result.output;
  await emit(events.shellResult({ requestId, command, output, ok: result.ok }));
  // A shell command can change repository state (checkout, commit, stage); re-announce
  // so the sidebar git line reflects it without polling. Latching + idempotent.
  announceOnline();
}

function spawnReplacementHost(opts: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly workspace: string;
}): { readonly pid: number } {
  // Re-exec with the SAME node invocation that started THIS process. Under the dev/start lanes the
  // host runs via tsx, which installs its TypeScript loader through process.execArgv (--require
  // preflight, --import loader) - NOT argv. Dropping execArgv respawns a bare `node src/main.ts`, which
  // dies instantly on the first extensionless `.ts` import (ERR_MODULE_NOT_FOUND); with stdio:"ignore"
  // that death is silent, so /cd, /clear, and /restart would leave the new session hostless ("starting
  // host…" forever). Carrying execArgv through reproduces the full launch; it's empty under a compiled
  // binary, so this is a no-op there.
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: opts.cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SESSION_ID: opts.sessionId,
      TREVOR_WORKSPACE: opts.workspace,
      TREVOR_MANAGED_HOST: "1",
      // tsx resolves tsconfig `paths` from the child's cwd, and the replacement's cwd is the TARGET
      // project - which has no @host/* mapping - so without this pointer the re-exec dies on its
      // first @host import (silently: stdio is "ignore"). Self-anchored so it also covers hosts
      // whose launcher didn't set it.
      TSX_TSCONFIG_PATH:
        process.env.TSX_TSCONFIG_PATH ?? join(import.meta.dirname, "..", "tsconfig.json"),
      // Carry the CURRENT debug flag (which may have been toggled at runtime via /debug, so it
      // isn't in process.env) across the re-exec, so a debug session stays in debug after /restart.
      ...(debugMode ? { TREVOR_DEBUG: "1" } : {}),
    },
  });
  child.unref();
  if (!child.pid) {
    throw new Error("replacement host did not report a pid");
  }
  return { pid: child.pid };
}

function retireAfterSessionSwitch(): void {
  const timer = setTimeout(() => {
    supervisor.killAll();
    if (process.env.TREVOR_MANAGED_HOST === "1") {
      process.exit(0);
    }
  }, 750);
  timer.unref();
}

async function clearToFreshSession(): Promise<void> {
  const nextSessionId = freshSessionId();
  try {
    await transport.ensureSession(nextSessionId);
    const spawned = spawnReplacementHost({
      cwd: process.cwd(),
      sessionId: nextSessionId,
      workspace: WORKSPACE_ROOT,
    });
    await emit(
      events.commandResult({
        command: "/clear",
        text: `✓ started fresh session ${nextSessionId}`,
        ok: true,
      }),
    );
    await emit(events.sessionSwitch({ sessionId: nextSessionId, reason: "clear" }));
    log("host", "clear: switched session", {
      from: SESSION_ID,
      to: nextSessionId,
      pid: spawned.pid,
    });
    retireAfterSessionSwitch();
  } catch (error) {
    warn("host", "clear: failed to switch session", { error: msg(error) });
    await emit(
      events.commandResult({
        command: "/clear",
        text: `Failed to start a fresh session: ${msg(error)}`,
        ok: false,
      }),
    );
  }
}

function workspaceSwitchBlocker(): string | null {
  const turns = scheduler.debug();
  if (scheduler.isBusy() || turns.queued > 0) {
    return "a turn is running or queued";
  }
  if (turns.compacting || manualCompactFiber) {
    return "compaction is running";
  }
  if (turnMachine.hasInFlight) {
    return "a prior run is still being reconciled";
  }
  if (backgroundChildren.size > 0) {
    return "background subagents are running";
  }
  const jobs = supervisor.list().filter((job) => job.status === "running");
  if (jobs.length > 0) {
    return `background jobs are running (${jobs.map((job) => job.id).join(", ")})`;
  }
  return null;
}

/**
 * The workspace-switch precondition the /cd, /handoff, and /worktree-* handlers all share: if a turn,
 * compaction, background subagent, or shell job is in flight, emit the command's bail result
 * ("Cannot <verb> while <blocker>.") and return true so the handler stops; otherwise false. One guard,
 * so a new switch command can't forget the blocker or word the bail differently.
 */
async function blockedFromWorkspaceSwitch(command: string, verb: string): Promise<boolean> {
  const blocker = workspaceSwitchBlocker();
  if (!blocker) {
    return false;
  }
  await emit(
    events.commandResult({ command, text: `Cannot ${verb} while ${blocker}.`, ok: false }),
  );
  return true;
}

async function cdToFreshSession(args: string): Promise<void> {
  if (await blockedFromWorkspaceSwitch("/cd", "switch directories")) {
    return;
  }

  const target = resolveCdTarget(args, { cwd: process.cwd() });
  if (!target.ok) {
    await emit(events.commandResult({ command: "/cd", text: target.error, ok: false }));
    return;
  }

  try {
    await transport.ensureSession(target.value.sessionId);
    const spawned = spawnReplacementHost(target.value);
    await emit(
      events.commandResult({
        command: "/cd",
        text: `✓ switched to ${target.value.cwd}`,
        ok: true,
      }),
    );
    await emit(events.sessionSwitch({ sessionId: target.value.sessionId, reason: "cd" }));
    log("host", "cd: switched session", {
      cwd: target.value.cwd,
      from: SESSION_ID,
      pid: spawned.pid,
      to: target.value.sessionId,
      workspace: target.value.workspace,
    });
    scheduler.clearPending();
    contextRegistry.reset();
    retireAfterSessionSwitch();
  } catch (error) {
    warn("host", "cd: failed to switch session", { error: msg(error) });
    await emit(
      events.commandResult({
        command: "/cd",
        text: `Failed to switch directories: ${msg(error)}`,
        ok: false,
      }),
    );
  }
}

/**
 * The shared workspace-switch mechanic (D-091): ensure the target session, spawn the replacement
 * host at the new cwd/workspace/session, publish the session.switch the browser follows, reset the
 * scheduler + lazy context, and retire this host. Used by worktree create/switch; `/cd` keeps its
 * own copy with its bespoke result text.
 */
async function switchToWorkspace(opts: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly reason: "cd" | "worktree";
}): Promise<void> {
  await transport.ensureSession(opts.sessionId);
  const spawned = spawnReplacementHost({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    workspace: opts.workspace,
  });
  await emit(events.sessionSwitch({ sessionId: opts.sessionId, reason: opts.reason }));
  log("host", `${opts.reason}: switched session`, {
    cwd: opts.cwd,
    from: SESSION_ID,
    pid: spawned.pid,
    to: opts.sessionId,
  });
  scheduler.clearPending();
  contextRegistry.reset();
  retireAfterSessionSwitch();
}

/**
 * Drafts pending generated handoffs by `handoffId`: the generated target prompt awaiting the user's
 * approve/edit/reject. Set when `handoff.generated` lands (live OR replayed, so a fresh leader can still
 * honor an approval) and cleared on the terminal `handoff.accepted` / `.rejected` / `.failed`. An
 * approval for an id not in this map is stale (host restarted past the draft) and is refused. <!-- D-003 -->
 */
const pendingHandoffs = new Map<string, { readonly prompt: string }>();
/** The in-flight handoff-draft generation fiber (one at a time), so a reject/cancel can interrupt it
 *  instead of letting an abandoned draft keep streaming into a `handoff.generated` nobody awaits. */
let handoffDraftFiber: Fiber.RuntimeFiber<string, unknown> | null = null;
/** A hung provider must not hang the draft forever: the generation fails (and the surface clears via
 *  handoff.failed) after this, so the handoff is never permanently stuck on a live host. */
const HANDOFF_GENERATION_TIMEOUT = "90 seconds";

/**
 * The real transport/mint/spawn/switch effects a handoff orchestrates, shared by direct mode and
 * generated approval so neither rebuilds target creation or the switch. Reuses the same
 * `spawnReplacementHost` + `session.switch` + retire mechanic as `/clear` and `/cd`. The injected
 * prompt rides the control producer (not PRODUCER_ID) so the target host schedules a turn for it
 * instead of ignoring it as a self-echo - the bug that left a handed-off session "Working" forever.
 */
function handoffDeps(): DirectHandoffDeps {
  return {
    sourceSessionId: SESSION_ID,
    cwd: process.cwd(),
    workspace: WORKSPACE_ROOT,
    newHandoffId: () => crypto.randomUUID(),
    newSessionId: () => freshSessionId(),
    targetModel: controlModel,
    publish: (sessionId, event) =>
      transport.publishEvent(sessionId, { ...event, producerId: PRODUCER_ID }),
    publishPrompt: (sessionId, event) =>
      transport.publishEvent(sessionId, { ...event, producerId: CONTROL_PRODUCER_ID }),
    ensureSession: async (sessionId) => {
      await transport.ensureSession(sessionId);
    },
    spawnHost: (target) => {
      spawnReplacementHost(target);
    },
    switchAndRetire: async (targetSessionId) => {
      await emit(events.sessionSwitch({ sessionId: targetSessionId, reason: "handoff" }));
      scheduler.clearPending();
      contextRegistry.reset();
      retireAfterSessionSwitch();
    },
  };
}

/**
 * `/handoff` (02): continue this session's work in a FRESH target session. Direct mode (`--direct
 * <prompt>`) injects the prompt verbatim and switches immediately; generated mode (`/handoff` or
 * `/handoff <request>`) drafts a target prompt with the provider and waits for the user to approve,
 * edit, or reject it (02.10) before any target launches. Both are gated by the workspace-switch
 * blocker so a handoff never abandons a running source turn (the exact failure the turn reconcile
 * guards against) - direct gates before switching, generated gates before drafting.
 */
async function runHandoff(args: string): Promise<void> {
  const { mode, prompt } = parseHandoff(args);
  if (await blockedFromWorkspaceSwitch("/handoff", "hand off")) {
    return;
  }
  if (mode === "generate") {
    await runGeneratedHandoff(prompt);
    return;
  }

  try {
    const result = await runDirectHandoff(prompt, handoffDeps());
    await emit(events.commandResult({ command: "/handoff", text: result.text, ok: result.ok }));
    if (result.ok) {
      log("host", "handoff: switched session", { from: SESSION_ID, to: result.targetSessionId });
    }
  } catch (error) {
    warn("host", "handoff failed", { error: msg(error) });
    await emit(
      events.commandResult({
        command: "/handoff",
        text: `Failed to hand off: ${msg(error)}`,
        ok: false,
      }),
    );
  }
}

/**
 * `/serial-implement <plans>` (plan 02): parse an ordered plan queue, record a durable, re-openable
 * serial run, and hand off to a dedicated session that implements the plans strictly one managed
 * worktree at a time (merge + delete each green tree; halt on the first red/conflict). The launching
 * session is freed by the handoff; the create/implement/merge/delete lifecycle runs in the spawned run.
 */
async function runSerialImplement(args: string): Promise<void> {
  if (await blockedFromWorkspaceSwitch("/serial-implement", "start a serial run")) {
    return;
  }
  try {
    const result = await startSerialRun(
      args,
      nodeSerialRunStartDeps({
        workspace: WORKSPACE_ROOT,
        stateHome: TREVOR_STATE_HOME,
        newRunId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        handoff: (prompt) =>
          runDirectHandoff(prompt, handoffDeps()).then((r) => ({
            ok: r.ok,
            ...(r.targetSessionId ? { targetSessionId: r.targetSessionId } : {}),
          })),
      }),
    );
    await emit(
      events.commandResult({ command: "/serial-implement", text: result.text, ok: result.ok }),
    );
    if (result.ok) {
      log("host", "serial run started", { runId: result.runId, to: result.targetSessionId });
    }
  } catch (error) {
    warn("host", "serial-implement failed", { error: msg(error) });
    await emit(
      events.commandResult({
        command: "/serial-implement",
        text: `Failed to start serial run: ${msg(error)}`,
        ok: false,
      }),
    );
  }
}

/** The host-driven controller caps for a serial run, rooted at the current cwd (resolves the base repo). */
function serialControllerCaps() {
  return nodeSerialControllerCaps({
    manager: worktrees,
    cwd: process.cwd(),
    stateHome: TREVOR_STATE_HOME,
    now: () => new Date().toISOString(),
  });
}

/**
 * `/serial-next <runId>` (plan 02): the host-driven half of the serial loop. Create + enter the next
 * queued plan's managed worktree and advance the durable journal to `tree-created`, then tell the run's
 * agent which plan to implement. The agent implements in the tree and calls `/serial-dispose` to merge it.
 */
async function runSerialNext(runId: string): Promise<void> {
  const id = runId.trim();
  const run = nodeLoadSerialRun(TREVOR_STATE_HOME, id);
  if (!run) {
    await emit(
      events.commandResult({
        command: "/serial-next",
        text: `unknown serial run: ${id}`,
        ok: false,
      }),
    );
    return;
  }
  const { plan } = await serialNext(run, serialControllerCaps());
  const text = !plan
    ? "serial run is complete or halted"
    : plan.phase === "merged"
      ? "all plans merged"
      : `next: implement ${plan.planId} in its worktree, then run /serial-dispose ${id}`;
  await emit(events.commandResult({ command: "/serial-next", text, ok: true }));
}

/**
 * `/serial-dispose <runId> [fail <reason>]` (plan 02): the host-driven disposition. After the agent
 * implemented the in-progress plan, run the single green gate (clean -> merge -> delete) on a green
 * report, or halt the run on `fail <reason>` - advancing the durable journal either way.
 */
async function runSerialDispose(args: string): Promise<void> {
  const [id, verb, ...rest] = args.trim().split(/\s+/);
  if (!id) {
    await emit(
      events.commandResult({
        command: "/serial-dispose",
        text: "usage: /serial-dispose <runId> [fail <reason>]",
        ok: false,
      }),
    );
    return;
  }
  const run = nodeLoadSerialRun(TREVOR_STATE_HOME, id);
  if (!run) {
    await emit(
      events.commandResult({
        command: "/serial-dispose",
        text: `unknown serial run: ${id}`,
        ok: false,
      }),
    );
    return;
  }
  const outcome =
    verb === "fail" ? { green: false, detail: rest.join(" ") || "reported red" } : { green: true };
  const updated = await disposeCurrentPlan(run, serialControllerCaps(), outcome);
  const halted = updated.plans.find((p) => p.phase === "halted");
  const text =
    updated.status === "halted"
      ? `⚠ halted on ${halted?.planId}: ${halted?.haltReason} - tree left intact for inspection`
      : updated.status === "complete"
        ? "✓ all plans merged"
        : `✓ merged; run /serial-next ${id} for the next plan`;
  await emit(
    events.commandResult({ command: "/serial-dispose", text, ok: updated.status !== "halted" }),
  );
}

/**
 * Generated handoff (02.10): emit the source lifecycle (`handoff.requested` generate -> `generating`),
 * draft the target prompt with the source's last-turn provider (the same provider compaction folds
 * with), then emit `handoff.generated` for the browser to surface for approval. No command result is
 * emitted here - the draft rides the approval surface, not a transcript line, so the source never shows
 * a misleading failure beside a pending draft. Failure (no context, no provider, provider error, empty
 * draft) emits a stable `handoff.failed` + a command result and leaves the source session active.
 */
async function runGeneratedHandoff(request: string): Promise<void> {
  const handoffId = crypto.randomUUID();
  const fail = async (code: string, detail: string, resultText: string) => {
    await emit(events.handoffFailed({ handoffId, code, detail }));
    await emit(events.commandResult({ command: "/handoff", text: resultText, ok: false }));
  };

  if (!hasGenerableContext(history)) {
    await fail(
      "empty_context",
      "No conversation to summarize into a handoff.",
      "Nothing to hand off yet — start the work first, then /handoff.",
    );
    return;
  }
  const provider = compactionController.providerOrDefault();
  if (!provider) {
    await fail(
      "no_provider",
      "No provider available to generate.",
      "No provider available to generate a handoff.",
    );
    return;
  }

  await emit(
    events.handoffRequested({
      handoffId,
      mode: "generate",
      sourceSessionId: SESSION_ID,
      ...(request.trim() ? { prompt: request.trim() } : {}),
    }),
  );
  await emit(events.handoffGenerating({ handoffId }));

  // Run the draft as a tracked fiber (not runPromiseExit) so a reject during drafting can interrupt it,
  // bounded by a timeout so a hung provider can't hang it forever.
  const fiber = Effect.runFork(
    generateHandoffPrompt(provider, {
      history: history.slice(),
      cwd: process.cwd(),
      workspace: WORKSPACE_ROOT,
      ...(request.trim() ? { request: request.trim() } : {}),
    }).pipe(Effect.timeout(HANDOFF_GENERATION_TIMEOUT)),
  );
  handoffDraftFiber = fiber;
  const exit = await Effect.runPromise(Fiber.await(fiber));
  handoffDraftFiber = null;

  if (Exit.isFailure(exit)) {
    // Interruption = the user cancelled mid-draft (rejectHandoff already acknowledged + cleared the
    // surface), so emit nothing further. Any other failure (provider error / timeout) fails the handoff.
    if (Cause.isInterruptedOnly(exit.cause)) {
      return;
    }
    warn("host", "handoff generation failed", { cause: Cause.pretty(exit.cause) });
    await fail(
      "generation_failed",
      "The provider failed or timed out while generating the handoff.",
      "Could not generate a handoff prompt — try again, or /handoff --direct <prompt>.",
    );
    return;
  }
  const draft = exit.value.trim();
  if (!draft) {
    await fail(
      "empty_generation",
      "The model produced no handoff prompt.",
      "The model produced an empty handoff prompt — try again, or /handoff --direct <prompt>.",
    );
    return;
  }

  pendingHandoffs.set(handoffId, { prompt: draft });
  await emit(events.handoffGenerated({ handoffId, prompt: draft }));
  log("host", "handoff: generated draft", { handoffId: handoffId.slice(0, 8) });
}

/**
 * The user approved a generated handoff (from the browser's approval surface). Runs the shared
 * finalized-execution path with the approved prompt - the edited text when the user edited it in the
 * prompt editor, else the generated draft. A stale id (no pending draft, e.g. the host restarted past
 * it) is a no-op with a clear command result; the source session stays active. <!-- D-003 -->
 */
async function approveHandoff(handoffId: string, editedPrompt: string | undefined): Promise<void> {
  const pending = pendingHandoffs.get(handoffId);
  const prompt = (editedPrompt ?? "").trim() || pending?.prompt?.trim() || "";
  if (!prompt) {
    await emit(
      events.handoffFailed({
        handoffId,
        code: "stale_approval",
        detail: "No pending handoff draft.",
      }),
    );
    await emit(
      events.commandResult({
        command: "/handoff",
        text: "This handoff is no longer pending — run /handoff again.",
        ok: false,
      }),
    );
    pendingHandoffs.delete(handoffId);
    return;
  }
  try {
    const result = await executeFinalizedHandoff({ handoffId, prompt }, handoffDeps());
    await emit(events.commandResult({ command: "/handoff", text: result.text, ok: result.ok }));
    log("host", "handoff: approved + switched", { from: SESSION_ID, to: result.targetSessionId });
  } catch (error) {
    warn("host", "handoff approve failed", { error: msg(error) });
    await emit(events.handoffFailed({ handoffId, code: "execute_failed", detail: msg(error) }));
    await emit(
      events.commandResult({
        command: "/handoff",
        text: `Failed to hand off: ${msg(error)}`,
        ok: false,
      }),
    );
  } finally {
    pendingHandoffs.delete(handoffId);
  }
}

/** The user rejected/cancelled a handoff: interrupt any in-flight draft, drop the pending draft, and
 *  acknowledge; the source session stays active. Works while drafting (interrupt) or after (no-op). */
async function rejectHandoff(handoffId: string): Promise<void> {
  pendingHandoffs.delete(handoffId);
  if (handoffDraftFiber) {
    const fiber = handoffDraftFiber;
    handoffDraftFiber = null;
    Effect.runFork(Fiber.interrupt(fiber));
  }
  await emit(
    events.commandResult({
      command: "/handoff",
      text: "Handoff cancelled — staying in this session.",
      ok: true,
    }),
  );
}

/** Switches to a managed worktree (or the baseline checkout) by row id, gated like `/cd`. */
async function worktreeSwitch(id: string): Promise<void> {
  if (await blockedFromWorkspaceSwitch("/worktree", "switch worktrees")) {
    return;
  }
  const target = worktrees.resolveSwitch(id, process.cwd());
  if (!target.ok) {
    await emit(events.commandResult({ command: "/worktree", text: target.error, ok: false }));
    return;
  }
  if (target.path === process.cwd()) {
    await emit(
      events.commandResult({ command: "/worktree", text: "Already on this worktree.", ok: true }),
    );
    return;
  }
  // Block the switch before spawning a host if a DIFFERENT live session already owns the target
  // directory (plan 01) - it would otherwise become a second mutating owner of the same path.
  const lockConflict = cwdSwitchConflict(target.path, target.sessionId, cwdLockCaps);
  if (lockConflict) {
    await emit(
      events.commandResult({
        command: "/worktree",
        text: `Cannot switch - ${lockConflict.message}`,
        ok: false,
      }),
    );
    return;
  }
  try {
    await emit(
      events.commandResult({
        command: "/worktree",
        text: `✓ switched to ${abbrevHome(target.path)}`,
        ok: true,
      }),
    );
    await switchToWorkspace({
      cwd: target.path,
      sessionId: target.sessionId,
      workspace: target.path,
      reason: "worktree",
    });
  } catch (error) {
    warn("host", "worktree: switch failed", { error: msg(error) });
    await emit(
      events.commandResult({
        command: "/worktree",
        text: `Failed to switch worktree: ${msg(error)}`,
        ok: false,
      }),
    );
  }
}

/** Creates a managed worktree on a new branch from HEAD, records it, and switches into it. */
async function worktreeNew(branch: string): Promise<void> {
  if (await blockedFromWorkspaceSwitch("/worktree-new", "create a worktree")) {
    return;
  }
  const name = branch.trim();
  if (!name) {
    await emit(
      events.commandResult({
        command: "/worktree-new",
        text: "usage: /worktree-new <branch>",
        ok: false,
      }),
    );
    return;
  }
  const result = worktrees.createFromCwd({
    cwd: process.cwd(),
    branch: name,
    baseRef: "HEAD",
  });
  if (!result.ok) {
    await emit(events.commandResult({ command: "/worktree-new", text: result.error, ok: false }));
    return;
  }
  try {
    await emit(
      events.commandResult({
        command: "/worktree-new",
        text: `✓ created ${name} and switched in`,
        ok: true,
      }),
    );
    await switchToWorkspace({
      cwd: result.record.worktreePath,
      sessionId: result.record.sessionId,
      workspace: result.record.worktreePath,
      reason: "worktree",
    });
  } catch (error) {
    warn("host", "worktree: create-switch failed", { error: msg(error) });
    await emit(
      events.commandResult({
        command: "/worktree-new",
        text: `Failed to open worktree: ${msg(error)}`,
        ok: false,
      }),
    );
  }
}

/** Merges a worktree's branch back into the baseline checkout (M5), gated like a switch. */
async function worktreeMerge(id: string): Promise<void> {
  if (await blockedFromWorkspaceSwitch("/worktree-merge", "merge")) {
    return;
  }
  const result = worktrees.mergeBack(id.trim(), process.cwd());
  await emit(
    events.commandResult({
      command: "/worktree-merge",
      text: result.ok ? "✓ merged worktree branch into baseline" : result.error,
      ok: result.ok,
    }),
  );
  if (result.ok) {
    announceOnline();
  }
}

/** Deletes a managed worktree (M5). `<id> [force]`; without force a dirty/unpushed tree is refused. */
async function worktreeDelete(args: string): Promise<void> {
  const [id, ...rest] = args.trim().split(/\s+/);
  const force = rest.includes("force");
  if (!id) {
    await emit(
      events.commandResult({
        command: "/worktree-delete",
        text: "usage: /worktree-delete <id> [force]",
        ok: false,
      }),
    );
    return;
  }
  const result = worktrees.remove(id, process.cwd(), force);
  await emit(
    events.commandResult({
      command: "/worktree-delete",
      text: result.ok ? "✓ deleted worktree" : result.error,
      ok: result.ok,
    }),
  );
  if (result.ok) {
    announceOnline();
  }
}

/** Toggles debug-command mode and re-announces, so the slash menu reveals/hides the debug set. */
function toggleDebug(): void {
  debugMode = !debugMode;
  log("host", "debug mode", { on: debugMode });
  emit(
    events.commandResult({
      command: "/debug",
      text: debugMode
        ? "✓ debug mode ON — extra commands available (try /restart)"
        : "debug mode OFF",
      ok: true,
    }),
  ).catch(() => {});
  // Re-announce so every client's command set (and slash menu) reflects the new surface.
  announceOnline();
}

/**
 * Restarts the host IN PLACE (debug-only): spawns a replacement on the SAME session/cwd and retires
 * this process, so a fresh `tsx main.ts` picks up code changes on demand. Unlike `/cd`/`/clear` it
 * keeps the session, so the browser stays put and just reconnects; an in-flight turn is orphaned and
 * the new leader reaps it. The headline reason debug mode exists: a stable (non-watch) host plus an
 * explicit "pick up my changes" instead of an auto-watch restart that silently breaks a live turn.
 */
async function restartHost(args: string): Promise<void> {
  // The typed `/restart` stays debug-gated (so a normal session can't be restarted by a stray
  // keystroke), but the sidebar's explicit "restart" button sends `force` to bypass the gate - a
  // deliberate click is its own confirmation and shouldn't require toggling debug first.
  const forced = args.trim() === "force";
  if (!debugMode && !forced) {
    await emit(
      events.commandResult({
        command: "/restart",
        text: "Run /debug first — /restart is a debug-mode command.",
        ok: false,
      }),
    );
    return;
  }
  try {
    const spawned = spawnReplacementHost({
      cwd: process.cwd(),
      sessionId: SESSION_ID,
      workspace: WORKSPACE_ROOT,
    });
    await emit(
      events.commandResult({
        command: "/restart",
        text: `✓ restarting host (pid ${spawned.pid}) — reconnecting with fresh code…`,
        ok: true,
      }),
    );
    log("host", "restart: replacement spawned", { pid: spawned.pid, session: SESSION_ID });
    retireAfterSessionSwitch();
  } catch (error) {
    warn("host", "restart failed", { error: msg(error) });
    await emit(
      events.commandResult({
        command: "/restart",
        text: `Failed to restart host: ${msg(error)}`,
        ok: false,
      }),
    );
  }
}

/**
 * Runs the graceful session teardown (D-094): abort active work (a clean cancelled completion where
 * the turn can still flush), clear the deferred queue so no successor answers stale prompts, and tear
 * down background jobs - in that order. Shared by the SIGTERM path (`trevor stop`) and the debug
 * `/stop` command; the CALLER exits the process afterward (which lapses the lease). The durable log is
 * never touched - nothing here can reach it.
 */
function performGracefulStop(): StopOutcome {
  // Free the cwd advisory lock for the next owner before we tear the session down (plan 01).
  releaseWorkspaceCwdLock();
  // Release this instance's local-model residency claim so a peer can reclaim/evict promptly instead of
  // waiting out the TTL (plan 11.1). The claim release flushes synchronously on the uncontended store
  // fast path; the follow-on unload sweep is best-effort and may be cut short by the imminent exit -
  // that's fine, a peer sweeps it. Fire-and-forget so teardown ordering is unchanged.
  void residency.shutdown();
  return stopSession({
    abortActive: () => abortRuns(""),
    clearQueue: () => scheduler.clearPending(),
    killJobs: () => supervisor.killAll(),
    isBusy: () => scheduler.isBusy(),
    queuedCount: () => scheduler.debug().queued,
  });
}

/**
 * The debug `/archive` and `/unarchive` commands (D-094 M4): flip the durable `session.archived` flag
 * for the CURRENT session. Archiving hides it from the sidebar and `/resume` (the open browser then
 * gates behind its unarchive notice); it never deletes history, and `/unarchive` is the exact inverse.
 * Debug-gated like `/restart` (the handler re-checks even though the spec is only announced in debug).
 */
async function setArchived(archived: boolean): Promise<void> {
  const command = archived ? "/archive" : "/unarchive";
  if (!debugMode) {
    await emit(
      events.commandResult({
        command,
        text: `Run /debug first — ${command} is a debug-mode command.`,
        ok: false,
      }),
    );
    return;
  }
  await emit(events.sessionArchived({ archived }));
  await emit(
    events.commandResult({
      command,
      text: archived
        ? "✓ archived — hidden from the sidebar and /resume (history preserved; /unarchive to restore)."
        : "✓ unarchived — restored to the sidebar and /resume.",
      ok: true,
    }),
  );
}

/**
 * The debug `/stop` command (D-094 M4): graceful session shutdown, gated behind debug mode AND an
 * explicit confirm because it ends the session. Bare `/stop` only describes the effect; `/stop
 * confirm` runs the same teardown as `trevor stop` (SIGTERM), reports what it tore down, then exits so
 * the lease lapses and the launcher reaps the ownership record. History is preserved throughout.
 */
async function stopCurrentSession(args: string): Promise<void> {
  if (!debugMode) {
    await emit(
      events.commandResult({
        command: "/stop",
        text: "Run /debug first — /stop is a debug-mode command.",
        ok: false,
      }),
    );
    return;
  }
  if (!isStopConfirmed(args)) {
    await emit(
      events.commandResult({
        command: "/stop",
        text: "Stop ends this session: it cancels the active turn, clears the queue, tears down background jobs, and shuts the host down. History is preserved. Run `/stop confirm` to proceed.",
        ok: true,
      }),
    );
    return;
  }
  let outcome: StopOutcome;
  try {
    outcome = performGracefulStop();
  } catch (error) {
    warn("host", "graceful stop failed; tearing down anyway", { error: msg(error) });
    supervisor.killAll();
    await emit(
      events.commandResult({
        command: "/stop",
        text: `Stopped (forced): ${msg(error)}`,
        ok: false,
      }),
    );
    process.exit(0);
  }
  log("host", "stopping (/stop)", {
    cancelledActive: outcome.cancelledActive,
    clearedQueued: outcome.clearedQueued,
  });
  await emit(
    events.commandResult({
      command: "/stop",
      text: `✓ stopped — ${outcome.cancelledActive ? "cancelled the active turn" : "no active turn"}, cleared ${outcome.clearedQueued} queued. Shutting down; history is preserved.`,
      ok: true,
    }),
  );
  process.exit(0);
}

/** Reconciles the registry against the filesystem, dropping worktrees whose path is gone (M5). */
async function worktreeReconcile(): Promise<void> {
  const gone = worktrees.reconcile(process.cwd());
  await emit(
    events.commandResult({
      command: "/worktree-reconcile",
      text:
        gone.length > 0 ? `✓ reconciled ${gone.length} stale worktree(s)` : "nothing to reconcile",
      ok: true,
    }),
  );
  if (gone.length > 0) {
    announceOnline();
  }
}

// The live host facts /doctor reads (D-073), extracted to doctor/host-facts (plan 22.2 M2): the
// reader is constructed once over the host's live singletons; the thin `doctorFacts` const keeps
// the registerDoctorSnapshotSource / runCommand call sites unchanged.
const hostFacts = makeHostFacts({
  scheduler,
  turnMachine,
  compactionController,
  internet,
  live: () => live,
  historyLength: () => history.length,
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
});
const doctorFacts = hostFacts.doctorFacts;

// The `doctor` tool (D-073 M6) has no CommandContext, so the host registers the snapshot accessor it
// reads: the SAME builder + facts the /doctor command uses, so command and tool never disagree.
registerDoctorSnapshotSource(async () =>
  buildLiveDoctorSnapshot({
    runtime: doctorFacts(),
    probes: await collectDoctorProbeResults(providers),
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
    ...doctorFacts(),
    providers,
    lease: lease.debugInfo(Date.now()),
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

/** Admits one event to the prompt projection and recomputes the derived history.
 *  The fold (mapping, artifacts, blank-filter, user collapse, /clear reset, tool reconstruction)
 *  is owned by buildHistory; this is the only place `history` is rebuilt. */
function admit(event: SessionEvent): void {
  historyEvents.push(event);
  history = buildHistory(historyEvents, { selfProducerId: PRODUCER_ID });
}

/** Pushes an event into the durable history WITHOUT rebuilding the projection - for events that
 *  accumulate but only matter at a turn boundary: tool.started/completed (buildHistory reconstructs
 *  them into the conversation and carries them across turns) and tasks.current (the compaction pin).
 *  `history` is read only at turn boundaries, so the next admit (the turn's assistant.completed, then
 *  the following user.message) rebuilds with them - a tool-heavy turn, or a burst of task updates,
 *  never re-folds the whole log per event. */
function recordEvent(event: SessionEvent): void {
  historyEvents.push(event);
}

/** Applies one live or replayed session event to the host's in-memory state. */
function handleEvent(message: SessionEvent): void {
  const decoded = decodeTrevorEvent(message);
  if (!decoded) {
    return;
  }
  if (decoded.type === "user.message" && isAnswerablePrompt(message.producerId, PRODUCER_ID)) {
    scheduler.noteTurn(message);
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
      const last = history[history.length - 1];
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
    abortRuns(decoded.runId);
  } else if (decoded.type === "model.switch.requested" && live && lease.isLeader()) {
    // LIVE LEADER ONLY (09.1). Route the switch into the in-flight turn's cell; the loop re-resolves at
    // its next step boundary and the host then emits model.switched. A request whose runId is not the
    // active switchable turn (or with no active turn) is a loop no-op - the web keeps its next-turn
    // selection (today's behavior). Like a cancel this is an ACTION, not state to rebuild on replay, so
    // it is gated live+leader and never re-applied during reconnect.
    if (
      decoded.model &&
      activeSwitch &&
      (decoded.runId === "" || activeSwitch.runId === decoded.runId)
    ) {
      const target = decoded.model;
      const reasoning = target.reasoning;
      // The target model's context window from the catalog (09.1 M7), so the loop can run the
      // larger->smaller fit guard; absent when the source/model is not in the catalog (guard then off).
      const targetWindow = catalogEntryFor(catalog.catalogBySource, target)?.contextLength;
      activeSwitch.cell.request({
        model: target,
        ...(reasoning != null ? { reasoning } : {}),
        initiator: decoded.initiator,
        ...(targetWindow != null ? { targetWindow } : {}),
      });
    }
  } else if (decoded.type === "user.command" && message.producerId !== PRODUCER_ID) {
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
      scheduler.clearPending();
      // Drop the lazily-loaded below-cwd AGENTS.md set too, so the fresh conversation starts with only
      // the eager scope (the eager up-tree is re-read from disk each turn regardless).
      contextRegistry.reset();
    }
    // Immediate command lane: only the leader answers, and only when live (commands
    // are actions, not state to rebuild on replay).
    if (live && lease.isLeader()) {
      const { command, args } = decoded;
      log("host", "command", { command, args: args || undefined });
      if (command === "/clear") {
        clearToFreshSession().catch((error) =>
          warn("host", "clear failed", { command, error: msg(error) }),
        );
        return;
      }
      if (command === "/cd") {
        cdToFreshSession(args).catch((error) =>
          warn("host", "cd failed", { command, error: msg(error) }),
        );
        return;
      }
      if (command === "/continue") {
        continueAfterStop(args.trim() || turnMachine.lastTermination || "manual continue")
          .then(() =>
            emit(
              events.commandResult({
                command,
                text: "Continuing from the paused turn.",
                ok: true,
              }),
            ),
          )
          .catch((error) => warn("host", "continue failed", { error: msg(error) }));
        return;
      }
      if (command === "/compress") {
        compressThenContinue()
          .then((result) => emit(events.commandResult({ command, ...result })))
          .catch((error) => warn("host", "compress failed", { error: msg(error) }));
        return;
      }
      if (command === "/retry") {
        retryLastPrompt()
          .then((result) => emit(events.commandResult({ command, ...result })))
          .catch((error) => warn("host", "retry failed", { error: msg(error) }));
        return;
      }
      // Explicit internet refresh (D-060 M2): the advisory's refresh button asks the host to run a
      // fresh public-internet probe NOW. Like the worktree actions it is a programmatic command, not
      // a typed slash, and produces no command.result - the monitor's `checking` start + settled
      // result ride the host.internet events the refresh already emits. refresh() never throws and
      // dedupes a probe already in flight, so a double-click is harmless.
      if (command === "/internet-refresh") {
        internet.refresh().catch(() => {});
        return;
      }
      // Catalog refresh (D-065): the chooser's "Refresh catalog" action re-queries each source's live
      // /models and re-announces sources+catalog. Programmatic (not a typed slash); produces no
      // command.result - the refreshed catalog rides the host.online re-announce.
      if (command === "/catalog-refresh") {
        refreshCatalog();
        return;
      }
      // Source sign-in (D-065 M5): start/cancel a host-owned OAuth device-code flow for a source.
      // Programmatic (sent by the chooser's authenticate action), not a typed slash; the flow's
      // progress rides host.sourceAuth events, so there is no command.result.
      if (command === "/source-signin") {
        startSourceSignIn(args.trim());
        return;
      }
      if (command === "/source-signin-cancel") {
        signInAbort?.abort();
        return;
      }
      // The user-pasted code for a browser+paste sign-in (Anthropic): resolve the host's pending wait.
      if (command === "/source-signin-code") {
        signInCodeResolver?.(args.trim());
        signInCodeResolver = null;
        return;
      }
      // Programmatic worktree actions (D-091): sent by the web switcher, not typed by users, so
      // they're intercepted here rather than registered as slash commands.
      if (command === "/worktree-switch") {
        worktreeSwitch(args.trim()).catch((error) =>
          warn("host", "worktree-switch failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/worktree-new") {
        worktreeNew(args).catch((error) =>
          warn("host", "worktree-new failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/worktree-merge") {
        worktreeMerge(args).catch((error) =>
          warn("host", "worktree-merge failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/worktree-delete") {
        worktreeDelete(args).catch((error) =>
          warn("host", "worktree-delete failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/worktree-reconcile") {
        worktreeReconcile().catch((error) =>
          warn("host", "worktree-reconcile failed", { error: msg(error) }),
        );
        return;
      }
      // Debug surface: /debug toggles the mode (always available); /restart is gated inside its
      // handler unless called with `force` (the sidebar restart button bypasses the gate).
      if (command === "/debug") {
        toggleDebug();
        return;
      }
      if (command === "/restart") {
        restartHost(args).catch((error) => warn("host", "restart failed", { error: msg(error) }));
        return;
      }
      // Debug lifecycle controls (D-094 M4): archive/unarchive flip the durable session flag; /stop is
      // graceful shutdown behind an explicit confirm. Each handler re-checks debug mode. Kill is NOT
      // here - a wedged host can't self-kill, so force-termination stays the CLI's `trevor kill`.
      if (command === "/archive") {
        setArchived(true).catch((error) => warn("host", "archive failed", { error: msg(error) }));
        return;
      }
      if (command === "/unarchive") {
        setArchived(false).catch((error) =>
          warn("host", "unarchive failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/stop") {
        stopCurrentSession(args).catch((error) =>
          warn("host", "stop failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/handoff") {
        runHandoff(args).catch((error) => warn("host", "handoff failed", { error: msg(error) }));
        return;
      }
      if (command === "/serial-implement") {
        runSerialImplement(args).catch((error) =>
          warn("host", "serial-implement failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/serial-next") {
        runSerialNext(args).catch((error) =>
          warn("host", "serial-next failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/serial-dispose") {
        runSerialDispose(args).catch((error) =>
          warn("host", "serial-dispose failed", { error: msg(error) }),
        );
        return;
      }
      if (command === "/clip") {
        runClip(args).catch((error) => warn("host", "clip failed", { error: msg(error) }));
        return;
      }
      if (command === "/tasks-clear") {
        // The task panel's dismiss control (09.1): retire a checklist the model abandoned on a topic
        // change. The empty tasks.current snapshot emitted via taskRegistry.onChange is the
        // confirmation (the panel hides itself when the list is empty).
        taskRegistry.clear();
        return;
      }
      runCommand(command, args).catch((error) =>
        warn("host", "command failed", { command, error: msg(error) }),
      );
    }
  } else if (decoded.type === "command.result") {
    // A /compact resolved (✓ / nothing / cancelled / failed): it no longer needs a result. Tracked
    // on replay too, so a fresh leader only reaps a genuinely-dangling /compact.
    if (decoded.command === "/compact") {
      compactPending = false;
    }
  } else if (decoded.type === "editor.open" && message.producerId !== PRODUCER_ID) {
    // Side-channel action (like commands): only the live leader acts, never on
    // replay - opening a file is a one-shot effect, not state to rebuild.
    if (live && lease.isLeader() && decoded.path) {
      log("host", "editor.open", { path: decoded.path });
      openInEditor(decoded.path, decoded.line, decoded.column).catch((error) =>
        warn("host", "editor.open failed", { path: decoded.path, error: msg(error) }),
      );
    }
  } else if (decoded.type === "user.shell" && message.producerId !== PRODUCER_ID) {
    // The prompt shell lane (D-082): a leading `!` ran a command. Like commands and editor.open it
    // is an ACTION, not state to rebuild - only the live leader executes it, never on replay or a
    // standby, so a reload never re-runs the command. The result is published as a `shell.result`
    // (paired by requestId), rendered as a terminal block; it never enters the model context.
    if (live && lease.isLeader() && decoded.command.trim()) {
      runShellCommand(decoded.requestId, decoded.command).catch((error) =>
        warn("host", "shell failed", { error: msg(error) }),
      );
    }
  } else if (decoded.type === "provider.question.answer" && message.producerId !== PRODUCER_ID) {
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
    pendingHandoffs.set(decoded.handoffId, { prompt: decoded.prompt });
  } else if (decoded.type === "handoff.accepted" || decoded.type === "handoff.failed") {
    // Terminal lifecycle: the draft is resolved, so drop it from the pending set (replay-safe).
    pendingHandoffs.delete(decoded.handoffId);
  } else if (decoded.type === "handoff.approved" && message.producerId !== PRODUCER_ID) {
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
    pendingHandoffs.delete(decoded.handoffId);
    if (live && lease.isLeader() && message.producerId !== PRODUCER_ID) {
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
  for (const event of historyEvents) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "user.message" && decoded.text.trim()) {
      const text = decoded.text.trim().replace(/\s+/g, " ");
      return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }
  }
  return SESSION_ID;
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
      events: historyEvents.slice(),
      foldThroughSeq: compactionController.lastFold?.throughSeq ?? null,
    }),
    siblings: createSiblingReader({
      transport,
      // A passive viewer identity (web runtime kind), so reading a sibling never registers this
      // host as a live host presence on that session.
      identity: {
        displayName: "trevor-recall",
        runtimeKind: RUNTIME_KIND.web,
        instanceId: INSTANCE_ID,
        participantId: `${PRODUCER_ID}:recall`,
      },
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
  history = [];
  historyEvents = [];
  // Rebuilt from replay; an in-flight turn's active run is left intact (its turn keeps
  // emitting over REST and its replayed completed clears it - resetting could race a
  // concurrent turn). The deferred queue + catch-up watermarks are rebuilt from replay.
  scheduler.resetForReconnect();
  transport.connectSession({
    sessionId: SESSION_ID,
    identity: {
      displayName: "trevor-host",
      runtimeKind: RUNTIME_KIND.host,
      instanceId: INSTANCE_ID,
      participantId: PARTICIPANT_ID,
    },
    onEvent: handleEvent,
    onReplayComplete: () => {
      live = true;
      goLive();
    },
    onStatus: (status) => {
      if (status === "open") {
        log("host", "joined session", { participant: PARTICIPANT_ID, session: SESSION_ID });
      } else if (status === "closed") {
        log("host", "socket closed; reconnecting", { ms: 1000 });
        setTimeout(connect, 1000);
      }
    },
  });
}

// Ctrl-C (SIGINT) is a quick exit: tear down child processes (dev servers, watchers) so they aren't
// orphaned, then go. No turn bookkeeping - an interactive Ctrl-C wants out now.
process.once("SIGINT", () => {
  releaseWorkspaceCwdLock();
  supervisor.killAll();
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
  process.exit(0);
});

configureRecall();
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
