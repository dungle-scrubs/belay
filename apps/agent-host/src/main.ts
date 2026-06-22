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
import { Lease } from "./lease";
import {
  buildProviders,
  type ChatMessage,
  DEFAULT_PROVIDER,
  describeProviders,
  pickProvider,
} from "./providers";
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

/** Stable per-process identity: shared producerId on events, unique stream id + instance. */
const INSTANCE_ID = crypto.randomUUID();
const PARTICIPANT_ID = `${PRODUCER_ID}:${INSTANCE_ID.slice(0, 8)}`;

// Single live connection's state (rebuilt from replay on each connect).
let live = false;
let history: ChatMessage[] = [];
let lastUserEvent: SessionEvent | null = null;
let lastAnswerSeq = -1;
let leaseRunning = false;

/** Publishes one event to the durable log, attaching this host's producerId. */
function emit(event: TrevorEventInput): Promise<void> {
  return publishEvent(SERVICE_URL, SESSION_ID, { ...event, producerId: PRODUCER_ID });
}

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
      console.log(`lease: ${role} (instance ${INSTANCE_ID.slice(0, 8)})`);
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
  publishTurn(
    emit,
    pickProvider(providers, decoded.provider),
    turnHistory,
    decoded.reasoning,
  ).catch((error) => console.error("turn error:", error));
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
  local
    .readiness()
    .then(({ warm }) => {
      if (!warm) {
        local.warm().catch((error) => console.error("warm error:", error));
      }
    })
    .catch(() => {});
}

/** On go-live: start the lease (once), announce presence, and report online. */
function goLive(): void {
  console.log("replay complete; live");
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
    }),
  ).catch(() => {});
}

/** Applies one live or replayed session event to the host's in-memory state. */
function handleEvent(message: SessionEvent): void {
  const decoded = decodeTrevorEvent(message);
  if (!decoded) {
    return;
  }
  if (decoded.type === "user.message" && message.producerId !== PRODUCER_ID) {
    // Collapse consecutive user turns. Two user messages with no assistant turn
    // between them means the earlier turn was abandoned/failed (it left no
    // assistant entry), so it's stale - drop it and answer the latest prompt
    // rather than feeding the model a pile of unanswered messages at once.
    const last = history[history.length - 1];
    if (last?.role === "user") {
      history[history.length - 1] = { role: "user", content: decoded.text };
    } else {
      history.push({ role: "user", content: decoded.text });
    }
    lastUserEvent = message;
    if (live) {
      respondTo(message, history.slice());
    }
  } else if (decoded.type === "assistant.completed") {
    if (decoded.text) {
      history.push({ role: "assistant", content: decoded.text });
    }
    lastAnswerSeq = Math.max(lastAnswerSeq, message.seq);
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
        console.log(`host ${PARTICIPANT_ID} joined session ${SESSION_ID}`);
      } else if (status === "closed") {
        console.log("socket closed; reconnecting in 1s");
        setTimeout(connect, 1000);
      }
    },
  });
}

console.log(
  `trevor-host ${PARTICIPANT_ID} starting; session=${SESSION_ID} providers=${Object.keys(
    providers,
  ).join(",")} default=${DEFAULT_PROVIDER}`,
);
ensureSession(SERVICE_URL, SESSION_ID)
  .then(() => connect())
  .catch((error) => {
    console.error("startup failed:", error);
    process.exit(1);
  });
