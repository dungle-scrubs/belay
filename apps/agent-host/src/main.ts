import { homedir } from "node:os";
import {
  connectSession,
  decodeTrevorEvent,
  ensureSession,
  events,
  publishEvent,
  type SessionEvent,
  type TrevorEventInput,
} from "@trevor/richter";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
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
import { msg } from "./tools/shared";
import { WORKSPACE_ROOT } from "./tools/workspace";
import { publishTurn } from "./turn";

/**
 * Trevor host: a Richter participant that runs an agent loop (model <-> tools) for
 * each new user.message over the full conversation, via a per-message-selectable
 * Provider (local qwen, or GPT-5.x over Codex OAuth) - both with tool calling.
 * It builds history from the event log, gates on replay, reports cold/warm
 * readiness, and defaults to a shared session ("trevor-local") so host and
 * browser auto-attach; override with SESSION_ID.
 *
 * The Richter transport (stream URL, replay-then-tail decode, REST publish) lives
 * in @trevor/richter and is shared with the web client; the trevor event names and
 * payload shapes come from its `events` constructors and `decodeTrevorEvent`, so
 * host and browser can never disagree on the protocol.
 *
 * Many hosts may share one session (each with a distinct participant id so
 * Richter lets them coexist), but only the lease LEADER answers turns; others
 * stand by and take over if the leader goes quiet (see ./lease).
 */

const SERVICE_URL = process.env.RICHTER_URL ?? "http://localhost:3025";
const SESSION_ID = process.env.SESSION_ID ?? "trevor-local";
const PRODUCER_ID = "trevor-host";
const providers = buildProviders();
const commands = buildCommandRegistry();

/** Stable per-process identity: shared producerId on events, unique stream id + instance. */
const INSTANCE_ID = crypto.randomUUID();
const PARTICIPANT_ID = `${PRODUCER_ID}:${INSTANCE_ID.slice(0, 8)}`;

// Single live connection's state (rebuilt from replay on each connect).
let live = false;
let history: ChatMessage[] = [];
let lastUserEvent: SessionEvent | null = null;
let lastAnswerSeq = -1;
let leaseRunning = false;
/** The turn currently being answered, if any - its fiber is interrupted on ESC/cancel. */
let activeRun: { readonly runId: string; readonly fiber: Fiber.RuntimeFiber<void, never> } | null =
  null;
/**
 * Prompts that arrived while a turn was in flight, awaiting their turn (FIFO). Only
 * one turn runs at a time, so a second prompt never spawns a concurrent turn; it
 * queues here and is answered when the active turn completes. Holding deferred
 * prompts out of `history` until they run also keeps history strictly paired
 * (user, assistant, user, assistant, ...) even if the log interleaves them.
 */
let deferredUserEvents: SessionEvent[] = [];

/** Publishes one event to the durable log, attaching this host's producerId. */
function emit(event: TrevorEventInput): Promise<void> {
  return publishEvent(SERVICE_URL, SESSION_ID, { ...event, producerId: PRODUCER_ID });
}

/** The live Emit service: the turn program's events go to the Richter log via emit(). */
const EmitLive = Layer.succeed(Emit, { publish: (event) => Effect.promise(() => emit(event)) });

/** A snapshot of the live turn machine for /doctor: what the host is doing right now. */
function hostState(): Record<string, unknown> {
  return {
    live,
    activeRun: activeRun ? activeRun.runId.slice(0, 8) : null,
    queued: deferredUserEvents.length,
    history: history.length,
    lastAnswerSeq,
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

/** Answers a user.message - but only when this host holds the lease. */
function respondTo(event: SessionEvent, turnHistory: readonly ChatMessage[]): void {
  if (event.producerId === PRODUCER_ID || !lease.isLeader()) {
    return;
  }
  const decoded = decodeTrevorEvent(event);
  if (decoded?.type !== "user.message") {
    return;
  }
  // Invariant: only one turn runs at a time. Callers gate on activeRun, so reaching here
  // with one set is a dispatch bug - drop the new turn rather than stream two at once.
  if (activeRun) {
    checkTurn(false, "respondTo while a turn is active", { active: activeRun.runId.slice(0, 8) });
    return;
  }
  // One fiber per turn: a user.cancel for this runId (ESC in the browser) interrupts it,
  // which tears down the in-flight provider stream and publishes the cancelled completion.
  const runId = crypto.randomUUID();
  const fiber = Effect.runFork(
    publishTurn(pickProvider(providers, decoded.provider), turnHistory, {
      runId,
      reasoning: decoded.reasoning,
    }).pipe(Effect.provide(EmitLive)),
  );
  activeRun = { runId, fiber };
  fiber.addObserver((exit) => {
    // publishTurn handles provider failures internally, so a non-interrupt failure here
    // is an unexpected defect worth surfacing.
    if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
      warn("host", "turn died", { run: runId.slice(0, 8), cause: Cause.pretty(exit.cause) });
    }
    if (activeRun?.runId === runId) {
      activeRun = null;
    }
  });
}

/** On becoming leader: answer any pending prompt, else pre-warm the local model. */
function onBecomeLeader(): void {
  if (lastUserEvent && lastUserEvent.seq > lastAnswerSeq) {
    respondTo(lastUserEvent, history.slice()); // catch up a prompt that arrived while probing
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

/**
 * Records a user prompt and either answers it now or queues it behind the active
 * turn. Exactly one turn runs at a time: a prompt that arrives mid-turn is deferred
 * and picked up when that turn completes (see drainDeferred), so turns never overlap
 * and the conversation stays strictly ordered.
 */
function handleUserMessage(message: SessionEvent, text: string): void {
  if (activeRun) {
    deferredUserEvents.push(message);
    return;
  }
  // Collapse consecutive user turns. With one-turn-at-a-time dispatch this only
  // fires for a genuinely abandoned turn (e.g. the host crashed mid-answer, leaving
  // a user message with no assistant entry) - replace it rather than feeding the
  // model two unanswered prompts at once.
  const last = history[history.length - 1];
  if (last?.role === "user") {
    history[history.length - 1] = { role: "user", content: text };
  } else {
    history.push({ role: "user", content: text });
  }
  lastUserEvent = message;
  if (live) {
    respondTo(message, history.slice());
  }
}

/** After a turn ends, start the next prompt that queued while it was running. */
function drainDeferred(): void {
  if (activeRun || !lease.isLeader()) {
    return;
  }
  const next = deferredUserEvents.shift();
  if (!next) {
    return;
  }
  const decoded = decodeTrevorEvent(next);
  if (decoded?.type === "user.message") {
    handleUserMessage(next, decoded.text);
  }
}

/** Applies one live or replayed session event to the host's in-memory state. */
function handleEvent(message: SessionEvent): void {
  const decoded = decodeTrevorEvent(message);
  if (!decoded) {
    return;
  }
  if (decoded.type === "user.message" && message.producerId !== PRODUCER_ID) {
    handleUserMessage(message, decoded.text);
  } else if (decoded.type === "assistant.completed") {
    if (decoded.text) {
      // Invariant: history stays strictly paired - an assistant reply lands only on top
      // of the user turn it answers. A different role on top means the pairing the loop
      // depends on has drifted (e.g. a missed/duplicated turn).
      const last = history[history.length - 1];
      checkTurn(last?.role === "user", "assistant reply with no preceding user turn", {
        last: last?.role ?? "none",
      });
      history.push({ role: "assistant", content: decoded.text });
    }
    lastAnswerSeq = Math.max(lastAnswerSeq, message.seq);
    // The turn finished: free the slot and answer whatever queued while it ran.
    // (.finally on the turn also clears activeRun; both are guarded by runId so
    // whichever lands first wins and the other is a no-op.)
    if (activeRun && activeRun.runId === decoded.runId) {
      activeRun = null;
    }
    if (live) {
      drainDeferred();
    }
  } else if (decoded.type === "user.cancel") {
    // Abort the active turn if the cancel targets it, or if the browser asked to
    // cancel "whatever is active" (empty runId, sent before assistant.started lands).
    if (activeRun && (decoded.runId === activeRun.runId || decoded.runId === "")) {
      log("host", "cancel: interrupting run", { run: activeRun.runId.slice(0, 8) });
      Effect.runFork(Fiber.interrupt(activeRun.fiber));
    }
  } else if (decoded.type === "user.command" && message.producerId !== PRODUCER_ID) {
    // Immediate command lane: only the leader answers, and only when live (commands
    // are actions, not state to rebuild on replay).
    if (live && lease.isLeader()) {
      const { command, args } = decoded;
      log("host", "command", { command, args: args || undefined });
      runCommand(command, args).catch((error) =>
        warn("host", "command failed", { command, error: msg(error) }),
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
  lastUserEvent = null;
  lastAnswerSeq = -1;
  // Rebuilt from replay; an in-flight turn's activeRun is left intact (its turn keeps
  // emitting over REST and its replayed completed clears it - resetting could race a
  // concurrent turn).
  deferredUserEvents = [];
  connectSession({
    serviceUrl: SERVICE_URL,
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
ensureSession(SERVICE_URL, SESSION_ID)
  .then(() => connect())
  .catch((error) => {
    warn("host", "startup failed", { error: msg(error) });
    process.exit(1);
  });
