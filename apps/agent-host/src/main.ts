import { homedir } from "node:os";
import { richterTransport } from "@trevor/richter";
import {
  decodeTrevorEvent,
  events,
  type SessionEvent,
  streamTransport,
  type TrevorEventInput,
} from "@trevor/session";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
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
  describeProviders,
  pickProvider,
} from "./providers";
import { Emit } from "./services";
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

const SESSION_ID = process.env.SESSION_ID ?? "trevor-local";
const PRODUCER_ID = "trevor-host";
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
/** The prompt projection: `history === buildHistory(historyEvents)`. The event log
 *  is what the host folds; a deferred mid-turn prompt is admitted only when it drains
 *  (the scheduler defers it out of the log), so the projection stays strictly paired. */
let history: ChatMessage[] = [];
let historyEvents: SessionEvent[] = [];
let leaseRunning = false;
// The turn-dispatch state (active run, deferred FIFO, catch-up watermarks) lives in
// the TurnScheduler constructed below, not in module mutables.

/** Publishes one event to the durable log, attaching this host's producerId. */
function emit(event: TrevorEventInput): Promise<void> {
  return transport.publishEvent(SESSION_ID, { ...event, producerId: PRODUCER_ID });
}

/** The live Emit service: the turn program's events go to the Richter log via emit(). */
const EmitLive = Layer.succeed(Emit, { publish: (event) => Effect.promise(() => emit(event)) });

/** A snapshot of the live turn machine for /doctor: what the host is doing right now. */
function hostState(): Record<string, unknown> {
  const turns = scheduler.debug();
  return {
    live,
    activeRun: turns.active,
    queued: turns.queued,
    history: history.length,
    lastAnswerSeq: turns.lastAnswerSeq,
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
  const fiber = Effect.runFork(
    publishTurn(pickProvider(providers, decoded.provider), turnHistory, {
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
const scheduler = new TurnScheduler({
  isLeader: () => lease.isLeader(),
  start: (event) => {
    admit(event);
    return live ? startTurn(event, history.slice()) : null;
  },
});

/** On becoming leader: answer any pending prompt, else pre-warm the local model. */
function onBecomeLeader(): void {
  const pending = scheduler.pendingCatchUp();
  if (pending) {
    scheduler.submit(pending); // catch up a prompt that arrived while probing
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
      providers: Object.keys(providers),
      default: DEFAULT_PROVIDER,
      models: describeProviders(providers),
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
  });
  await emit(events.commandResult({ command: name, text, ok }));
}

/** Admits one event to the prompt projection and recomputes the derived history.
 *  The fold (mapping, artifacts, blank-filter, user collapse, /clear reset) is owned
 *  by buildHistory; this is the only place history changes. */
function admit(event: SessionEvent): void {
  historyEvents.push(event);
  history = buildHistory(historyEvents, { selfProducerId: PRODUCER_ID });
}

/** Applies one live or replayed session event to the host's in-memory state. */
function handleEvent(message: SessionEvent): void {
  const decoded = decodeTrevorEvent(message);
  if (!decoded) {
    return;
  }
  if (decoded.type === "user.message" && message.producerId !== PRODUCER_ID) {
    scheduler.submit(message);
  } else if (decoded.type === "assistant.completed") {
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
    // The turn finished: note the answered seq, free the slot, and (live only) answer
    // whatever queued while it ran. Draining follows the completion event, not the fiber
    // exit, so the next turn's prompt view already includes this reply (just admitted).
    scheduler.recordAnswer(decoded.runId, message.seq);
    if (live) {
      scheduler.drain();
    }
  } else if (decoded.type === "user.cancel") {
    // Abort the active turn if the cancel targets it, or if the browser asked to
    // cancel "whatever is active" (empty runId, sent before assistant.started lands).
    scheduler.cancel(decoded.runId);
  } else if (decoded.type === "user.command" && message.producerId !== PRODUCER_ID) {
    if (decoded.command === "/clear") {
      // Admit the clear so the projection resets from this point - applied on replay
      // too, so a reload/restart stays clean. The old events remain in the durable log
      // but buildHistory drops everything before the clear (sanitizeHistory also strips
      // a stray leading assistant turn if a clear lands mid-answer). The scheduler drops
      // its queued prompts + catch-up target alongside (the active run is left to finish).
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
      runtimeKind: "trevor",
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
transport
  .ensureSession(SESSION_ID)
  .then(() => connect())
  .catch((error) => {
    warn("host", "startup failed", { error: msg(error) });
    process.exit(1);
  });
