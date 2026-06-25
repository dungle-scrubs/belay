import { homedir } from "node:os";
import { richterTransport } from "@trevor/richter";
import {
  DEFAULT_SESSION_ID,
  decodeTrevorEvent,
  events,
  PRODUCER_IDS,
  RUNTIME_KIND,
  type SessionEvent,
  streamTransport,
  type TrevorEventInput,
  type Usage,
  type UsageBreakdown,
} from "@trevor/session";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import { COMPACT_WHEN, overBudget, runCompaction } from "./agent/compactor";
import { buildHistory } from "./agent/history-projection";
import { type ActiveTurn, TurnScheduler } from "./agent/turn-scheduler";
import { buildCommandRegistry } from "./commands";
import { Lease } from "./lease";
import { log, warn } from "./log";
import { supervisor } from "./processes";
import {
  buildProviders,
  type ChatMessage,
  DEFAULT_PROVIDER,
  type Provider,
  type ProviderError,
  pickProvider,
} from "./providers";
import { Emit } from "./services";
import { ensureSessionWithRetry } from "./startup";
import { taskRegistry } from "./tasks";
import { openInEditor } from "./tools/open-editor";
import { msg } from "./tools/shared";
import { WORKSPACE_ROOT } from "./tools/workspace";
import { publishTurn } from "./turn";

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
 * stand by and take over if the leader goes quiet (see ./lease).
 */

const SESSION_ID = process.env.SESSION_ID ?? DEFAULT_SESSION_ID;
const PRODUCER_ID = PRODUCER_IDS.host;
// Backend selection (the plugin seam): default to the local session-store; set
// RICHTER_URL to opt into the Richter durable substrate instead. The host speaks
// the SessionTransport contract either way.
const RICHTER_URL = process.env.RICHTER_URL;
const SESSION_STORE_URL = process.env.SESSION_STORE_URL ?? "http://127.0.0.1:17424";
const transport = RICHTER_URL ? richterTransport(RICHTER_URL) : streamTransport(SESSION_STORE_URL);
const providers = buildProviders();
const commands = buildCommandRegistry();

/** Stable per-process identity: shared producerId on events, unique stream id + instance. */
const INSTANCE_ID = crypto.randomUUID();
const PARTICIPANT_ID = `${PRODUCER_ID}:${INSTANCE_ID.slice(0, 8)}`;

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

/** Run ids that already have a terminal assistant.completed published. A cancel emits the
 *  completion IMMEDIATELY (so clients free instantly) and the turn fiber's onExit also tries to -
 *  this dedupes so a run closes exactly once. (Grows with run count; bounded by the session.) */
const completedRuns = new Set<string>();

/** The live Emit service: the turn program's events go to the Richter log via emit(). A second
 *  assistant.completed for an already-completed run (the fiber's onExit racing the immediate cancel)
 *  is dropped. */
const EmitLive = Layer.succeed(Emit, {
  publish: (event) =>
    Effect.promise(() => {
      if (event.type === "assistant.completed") {
        const runId = typeof event.payload.runId === "string" ? event.payload.runId : "";
        if (runId) {
          if (completedRuns.has(runId)) {
            return Promise.resolve();
          }
          completedRuns.add(runId);
        }
      }
      return emit(event);
    }),
});

/** A snapshot of the live turn machine for /doctor: what the host is doing right now. */
function hostState(): Record<string, unknown> {
  const turns = scheduler.debug();
  return {
    live,
    activeRun: turns.active,
    queued: turns.queued,
    history: history.length,
    lastAnswerSeq: turns.lastAnswerSeq,
    compacting: turns.compacting,
    ...(lastFold
      ? {
          lastFold: `seq≤${lastFold.throughSeq} ~${lastFold.tokensBefore}→${lastFold.tokensAfter}tok`,
        }
      : {}),
  };
}

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
  emit(events.tasksCurrent({ tasks: taskRegistry.snapshot() })).catch(() => {});
});

/** Lease timings are overridable via env so tests can run fast. */
function leaseOptions() {
  const num = (value: string | undefined) => (value ? Number(value) : undefined);
  return {
    heartbeatMs: num(process.env.LEASE_HEARTBEAT_MS),
    probeMs: num(process.env.LEASE_PROBE_MS),
    ttlMs: num(process.env.LEASE_TTL_MS),
    settleMs: num(process.env.LEASE_SETTLE_MS),
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

/** Abbreviates the user's home directory to ~ for display. */
function abbrevPath(absolute: string): string {
  const home = homedir();
  if (absolute === home) {
    return "~";
  }
  return absolute.startsWith(`${home}/`) ? `~${absolute.slice(home.length)}` : absolute;
}

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
  if (event.producerId === PRODUCER_ID || !lease.isLeader()) {
    return null;
  }
  const decoded = decodeTrevorEvent(event);
  if (decoded?.type !== "user.message") {
    return null;
  }
  const runId = crypto.randomUUID();
  const provider = pickProvider(providers, decoded.provider);
  // Remember the turn's provider so a between-turn fold summarizes with the same model (D-043).
  lastProvider = provider;
  const fiber = Effect.runFork(
    publishTurn(provider, turnHistory, {
      runId,
      reasoning: decoded.reasoning,
    }).pipe(Effect.provide(EmitLive)),
  );
  fiber.addObserver((exit) => {
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
let lastInput = 0;
let lastWindow = 0;
let compactionFloorReached = false;
let lastProvider: Provider | undefined;
/** The in-flight MANUAL `/compact` fold, so ESC can interrupt it (the user asked, so they can take
 *  it back). Only the manual fold is tracked - automatic folds are not interruptible (the blocking
 *  one is load-bearing for the next turn). Null when no manual fold is running. */
let manualCompactFiber: Fiber.RuntimeFiber<TrevorEventInput | null, ProviderError> | null = null;
/** True between a `/compact` command and its `command.result`. If a host dies mid-fold the command
 *  is left with no result (a dangling `/compact` that looks broken); the next leader gives it one. */
let compactPending = false;
/** The most recent fold, for /doctor (null until the first compaction). */
let lastFold: { throughSeq: number; tokensBefore: number; tokensAfter: number } | null = null;

/** Run ids whose assistant.started has no assistant.completed yet - the turns in flight. Tracked
 *  from the replayed + live log so a leader can REAP the ones a previous leader left dangling when
 *  it crashed or hot-reloaded mid-turn (see reapOrphans). Without that, every client reads the
 *  dangling run as still-active forever: the send queue freezes (prompts stuck "queued") and ESC
 *  targets a run no fiber backs (cancel is a no-op). */
const inFlightRuns = new Set<string>();

/** The latest usage/breakdown seen per in-flight run (from assistant.progress). A cancel/reap closes
 *  a run with NO usage of its own, but the turn still consumed what it consumed - so the terminal
 *  completion carries this last-known usage instead of dropping it (keeps the ctx meter + token
 *  accounting honest across a cancel). Cleared when the run's completion lands. */
const lastUsageByRun = new Map<string, { usage?: Usage; breakdown?: UsageBreakdown }>();

/**
 * Publishes the terminal completion for a run being closed WITHOUT a completion of its own - a user
 * cancel (ESC) or a host reap of an orphan. Dedups via `completedRuns` (the fiber's own onExit is
 * dropped, so the run closes exactly once) and carries the run's last-known usage, since the tokens
 * it consumed don't vanish on a cancel. `cancelled` = the user pressed ESC; `interrupted` = the host
 * closed it (restart/crash mid-turn), rendered as a muted "host restarted" note rather than an ESC.
 */
function closeRun(runId: string, kind: "cancelled" | "interrupted"): void {
  if (completedRuns.has(runId)) {
    return;
  }
  completedRuns.add(runId);
  const last = lastUsageByRun.get(runId);
  emit(
    events.assistantCompleted({
      runId,
      text: "",
      ...(kind === "cancelled" ? { cancelled: true } : { interrupted: true }),
      ...(last?.usage ? { usage: last.usage } : {}),
      ...(last?.breakdown ? { breakdown: last.breakdown } : {}),
    }),
  ).catch(() => {});
}

/**
 * Closes runs left dangling by a previous leader (crashed or hot-reloaded mid-turn): an
 * assistant.started with no completion. Called on TAKING leadership, when this host has no turn of
 * its own running, so every in-flight run is a dead orphan. Closes each as `interrupted`, which
 * unfreezes the send queue and makes ESC meaningful again on the next real turn. Idempotent: each
 * emitted completion echoes back and the set is cleared.
 */
function reapOrphans(): void {
  if (inFlightRuns.size === 0) {
    return;
  }
  for (const runId of [...inFlightRuns]) {
    if (completedRuns.has(runId)) {
      continue; // already closed (e.g. the user cancelled it)
    }
    log("host", "reaping orphaned run", { run: runId.slice(0, 8) });
    closeRun(runId, "interrupted");
  }
  inFlightRuns.clear();
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
  return (
    live &&
    lease.isLeader() &&
    !compactionFloorReached &&
    overBudget(lastInput, lastWindow, COMPACT_WHEN)
  );
}

/**
 * Kicks off ONE fold off the idle slot: plan + summarize + emit `context.compacted`. The fold's own
 * echo (handled below) admits it, updates the budget estimate, and releases the gate. A no-fold
 * result (nothing left to fold) or any failure marks the floor and releases the gate directly, so
 * the gate never loops. Not live/leader (or no provider) just releases the gate.
 */
function startCompaction(): void {
  const provider = lastProvider ?? providers[DEFAULT_PROVIDER];
  if (!live || !lease.isLeader() || !provider) {
    scheduler.finishCompaction();
    return;
  }
  const foldId = crypto.randomUUID();
  Effect.runFork(
    runCompaction(
      provider,
      historyEvents.slice(),
      lastWindow,
      PRODUCER_ID,
      lastInput,
      foldId,
      compactionProgress(foldId),
    ).pipe(
      Effect.flatMap((event) =>
        event
          ? // Its echo (the context.compacted case in handleEvent) admits it + releases the gate.
            Effect.promise(() => emit(event))
          : Effect.sync(() => {
              compactionFloorReached = true; // nothing left to fold - stop until the next turn
              scheduler.finishCompaction();
            }),
      ),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          warn("host", "compaction failed", { cause: Cause.pretty(cause) });
          compactionFloorReached = true;
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
  needsCompaction,
  compact: startCompaction,
});

/** On becoming leader: answer any pending prompt, else pre-warm the local model. */
function onBecomeLeader(): void {
  if (inFlightRuns.size > 0) {
    // A previous leader left turns dangling (crashed / hot-reloaded mid-turn). Close them so every
    // client stops reading them as active (unfreezes the send queue, makes ESC meaningful), and drop
    // the pending prompt - it was already attempted and interrupted, so the host idles clean instead
    // of auto-re-running a slow turn; the user re-submits if they want it.
    reapOrphans();
    scheduler.clearPending();
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

/** On go-live: start the lease (once), announce presence, and report online. */
function goLive(): void {
  log("host", "replay complete; live");
  if (!leaseRunning) {
    leaseRunning = true;
    lease.start(Date.now());
    setInterval(() => lease.tick(Date.now()), 500);
  }
  emit(events.hostHello({ instanceId: INSTANCE_ID })).catch(() => {});
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
      cwd: abbrevPath(process.cwd()),
      workspace: abbrevPath(WORKSPACE_ROOT),
      // The immediate-command inventory, so the browser knows which slashes route
      // to the host's command lane (and can drive a slash menu).
      commands: commands.specs,
    }),
  ).catch(() => {});
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
  const provider = lastProvider ?? providers[DEFAULT_PROVIDER];
  if (!provider) {
    return "No provider available to summarize.";
  }
  const foldId = crypto.randomUUID();
  // Forked (not awaited inline) so ESC can interrupt it - the summary's provider stream aborts on
  // interrupt. On interrupt nothing is emitted, so the context is left exactly as it was.
  const fiber = Effect.runFork(
    runCompaction(
      provider,
      historyEvents.slice(),
      lastWindow,
      PRODUCER_ID,
      lastInput,
      foldId,
      compactionProgress(foldId),
      true, // force: fold regardless of the current context %
    ),
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
  return `✓ compacted ~${Number(event.payload.tokensBefore)} → ~${Number(event.payload.tokensAfter)} tokens`;
}

/**
 * Runs an immediate host command and publishes its result. Unlike a user.message
 * this never touches the model or the turn queue - it executes now, even while a
 * turn is streaming, and answers with a single command.result.
 */
async function runCommand(name: string, args: string): Promise<void> {
  const { text, ok } = await commands.run(name, args, {
    providers,
    cwd: abbrevPath(process.cwd()),
    workspace: abbrevPath(WORKSPACE_ROOT),
    instanceId: INSTANCE_ID.slice(0, 8),
    role: lease.isLeader() ? "leader" : "standby",
    host: hostState(),
    lease: lease.debugInfo(Date.now()),
    compact: forceCompact,
  });
  await emit(events.commandResult({ command: name, text, ok }));
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
  if (decoded.type === "user.message" && message.producerId !== PRODUCER_ID) {
    scheduler.noteTurn(message);
  } else if (decoded.type === "assistant.started") {
    // Track the run as in flight (a started with no completion) so a later leader can reap it if a
    // crash/reload leaves it dangling. Cleared on its completion below.
    inFlightRuns.add(decoded.runId);
    // Note the attempt so catch-up never re-runs this prompt after a restart (replayed too).
    scheduler.noteTurn(message);
  } else if (decoded.type === "assistant.progress") {
    // Track the LIVE prompt size as the turn streams, so the compaction gate + /compact's reported
    // before-size stay current even when the turn is CANCELLED (a cancel carries no usage of its
    // own). Also stash the per-run usage so the cancel/reap completion can carry it.
    if (decoded.usage) {
      lastInput = decoded.usage.input;
      lastWindow = decoded.usage.contextWindow;
      lastUsageByRun.set(decoded.runId, { usage: decoded.usage, breakdown: decoded.breakdown });
    }
  } else if (decoded.type === "assistant.completed") {
    inFlightRuns.delete(decoded.runId); // the run finished (normally, cancelled, or reaped)
    lastUsageByRun.delete(decoded.runId);
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
      lastInput = decoded.usage.input;
      lastWindow = decoded.usage.contextWindow;
    }
    compactionFloorReached = false;
    // The turn finished: free the slot + note the answered seq, drain whatever queued while it ran
    // (blocking-before: a queued prompt folds first if over budget), then fold proactively in the
    // idle slot when nothing is queued (D-041) - that ordering is owned by processCompletion. The
    // next turn's prompt view already includes this reply (admitted just above). Inert off-live: the
    // forked `start` returns null during replay and the proactive fold gates on liveness.
    scheduler.processCompletion(decoded.runId, message.seq);
  } else if (decoded.type === "context.compacted") {
    // A fold landed (our own echo, or the leader's on a standby): admit it so the projection
    // shrinks to pins + summary + recent, drop the budget estimate to its post-fold size, and
    // release the compaction gate so any turn deferred behind it can now start.
    admit(message);
    lastInput = decoded.tokensAfter;
    lastFold = {
      throughSeq: decoded.throughSeq,
      tokensBefore: decoded.tokensBefore,
      tokensAfter: decoded.tokensAfter,
    };
    scheduler.finishCompaction();
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
    // Interrupt a MANUAL /compact if one is running (the user asked for it, so they can take it
    // back). Automatic folds aren't tracked here, so they run to completion. The fold's bar vanishes
    // via the web's user.cancel reap; nothing was emitted, so the context is unchanged.
    if (manualCompactFiber) {
      Effect.runFork(Fiber.interrupt(manualCompactFiber));
    }
    const targets = decoded.runId ? [decoded.runId] : [...inFlightRuns];
    for (const runId of targets) {
      closeRun(runId, "cancelled");
    }
    scheduler.cancel(decoded.runId);
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
    }
    // Immediate command lane: only the leader answers, and only when live (commands
    // are actions, not state to rebuild on replay).
    if (live && lease.isLeader()) {
      const { command, args } = decoded;
      log("host", "command", { command, args: args || undefined });
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
  } else if (decoded.type === "tasks.current") {
    // Recorded WITHOUT a rebuild: the task list only matters as a compaction pin (history-projection)
    // read at the next turn boundary, so a burst of task updates never re-folds the whole log per
    // update - the next real admit (the turn's completion) picks up the latest tasks.
    recordEvent(message);
    // Restore the checklist from the log on replay, and keep standbys in sync for
    // failover. The live leader owns the registry (it mutates it directly), so it
    // ignores the read-back of its own snapshot to avoid clobbering newer edits.
    if (!live || !lease.isLeader()) {
      taskRegistry.load(decoded.tasks);
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

// Background processes are children of this host; SIGTERM them on shutdown so a
// Ctrl-C doesn't leave dev servers or watchers orphaned.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    supervisor.killAll();
    process.exit(0);
  });
}

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
