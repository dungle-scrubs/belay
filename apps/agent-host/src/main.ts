import { decodeServerEnvelope, type SessionEvent } from "@trevor/richter";
import { Either } from "effect";
import { runAgent } from "./agent/loop";
import { Lease } from "./lease";
import { buildProviders, type ChatMessage, DEFAULT_PROVIDER, type Provider } from "./providers";

/**
 * Trevor host: a Richter participant that runs an agent loop (model <-> tools) for
 * each new user.message over the full conversation, via a per-message-selectable
 * Provider (local qwen, or GPT-5.x over Codex OAuth) - both with tool calling.
 * It builds history from the event log, gates on replay, reports cold/warm
 * readiness, and defaults to a shared session ("trevor-local") so host and
 * browser auto-attach; override with SESSION_ID.
 *
 * Many hosts may share one session (each with a distinct participant id so
 * Richter lets them coexist), but only the lease LEADER answers turns; others
 * stand by and take over if the leader goes quiet (see ./lease).
 */

const SERVICE_URL = process.env.RICHTER_URL ?? "http://localhost:3025";
const SESSION_ID = process.env.SESSION_ID ?? "trevor-local";
const PRODUCER_ID = "trevor-host";
const DELTA_FLUSH_CHARS = 40;
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
      publish("host.beat", { instanceId: INSTANCE_ID }).catch(() => {});
    },
    emitHello: () => {
      publish("host.hello", { instanceId: INSTANCE_ID }).catch(() => {});
    },
    onRoleChange: (role) => {
      console.log(`lease: ${role} (instance ${INSTANCE_ID.slice(0, 8)})`);
      publish("host.role", { instanceId: INSTANCE_ID, role }).catch(() => {});
      if (role === "leader") {
        onBecomeLeader();
      }
    },
  },
  leaseOptions(),
);

/** Resolves the provider key the browser chose to a concrete provider. */
function pickProvider(key: unknown): Provider {
  return key === "gpt" ? providers.gpt : providers.qwen;
}

/** Ensures the session exists (idempotent) so host and browser share a default. */
async function ensureSession(): Promise<void> {
  await fetch(`${SERVICE_URL}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION_ID }),
  });
}

/** Builds the participant stream URL, mirroring Richter's query-param contract. */
function streamUrl(afterSeq: number): string {
  const url = new URL(`/sessions/${SESSION_ID}/stream`, SERVICE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("after", String(afterSeq));
  url.searchParams.set("capabilities", "{}");
  url.searchParams.set("displayName", "trevor-host");
  url.searchParams.set("instanceId", INSTANCE_ID);
  url.searchParams.set("participantId", PARTICIPANT_ID);
  url.searchParams.set("runtimeKind", "trevor");
  return url.toString();
}

/** Publishes one event to the durable log via REST (producerId is the shared host id). */
async function publish(type: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${SERVICE_URL}/sessions/${SESSION_ID}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, producerId: PRODUCER_ID, payload }),
  });
  if (!response.ok) {
    throw new Error(`publish failed: HTTP ${response.status}`);
  }
}

/** Runs the agent loop for one turn, publishing text deltas and tool events. */
async function runTurn(provider: Provider, turnHistory: readonly ChatMessage[]): Promise<void> {
  const runId = crypto.randomUUID();
  const { warm } = await provider.readiness();
  await publish("assistant.started", { runId, warm, model: provider.model, provider: provider.id });

  let pending = "";
  let full = "";
  const flush = async (): Promise<void> => {
    if (pending) {
      const text = pending;
      pending = "";
      await publish("assistant.delta", { runId, text });
    }
  };

  try {
    for await (const event of runAgent(provider, turnHistory)) {
      if (event.type === "text") {
        pending += event.text;
        full += event.text;
        if (pending.length >= DELTA_FLUSH_CHARS) {
          await flush();
        }
      } else if (event.type === "tool_start") {
        await flush();
        await publish("tool.started", {
          runId,
          callId: event.call.id,
          name: event.call.name,
          arguments: event.call.arguments,
        });
      } else {
        await publish("tool.completed", {
          runId,
          callId: event.call.id,
          name: event.call.name,
          result: event.result.slice(0, 4000),
        });
      }
    }
  } catch (error) {
    await flush();
    await publish("assistant.completed", {
      runId,
      text: full,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  await flush();
  await publish("assistant.completed", { runId, text: full });
}

/** Answers a user.message - but only when this host holds the lease. */
function respondTo(event: SessionEvent, turnHistory: readonly ChatMessage[]): void {
  if (event.type !== "user.message" || event.producerId === PRODUCER_ID || !lease.isLeader()) {
    return;
  }
  runTurn(pickProvider(event.payload.provider), turnHistory).catch((error) =>
    console.error("turn error:", error),
  );
}

/** On becoming leader: answer any pending prompt, else pre-warm the local model. */
function onBecomeLeader(): void {
  if (lastUserEvent && lastUserEvent.seq > lastAnswerSeq) {
    respondTo(lastUserEvent, history.slice()); // catch up a prompt that arrived while probing
    return;
  }
  providers.qwen
    .readiness()
    .then(({ warm }) => {
      if (!warm) {
        providers.qwen.warm().catch((error) => console.error("warm error:", error));
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
  publish("host.hello", { instanceId: INSTANCE_ID }).catch(() => {});
  publish("host.online", {
    providers: ["qwen", "gpt"],
    default: DEFAULT_PROVIDER,
    instanceId: INSTANCE_ID,
  }).catch(() => {});
}

/** Connects to the session stream (replay-then-tail) with simple reconnect. */
function connect(): void {
  const socket = new WebSocket(streamUrl(0));
  live = false;
  history = [];
  lastUserEvent = null;
  lastAnswerSeq = -1;
  socket.addEventListener("open", () =>
    console.log(`host ${PARTICIPANT_ID} joined session ${SESSION_ID}`),
  );
  socket.addEventListener("close", () => {
    console.log("socket closed; reconnecting in 1s");
    setTimeout(connect, 1000);
  });
  socket.addEventListener("message", (event) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String((event as { data: unknown }).data));
    } catch {
      return;
    }
    const decoded = decodeServerEnvelope(raw);
    if (Either.isLeft(decoded)) {
      return;
    }
    const envelope = decoded.right;
    if (envelope.op === "replay.complete") {
      live = true;
      goLive();
      return;
    }
    if (envelope.op !== "event") {
      return;
    }
    const message = envelope.event;
    if (message.type === "user.message" && message.producerId !== PRODUCER_ID) {
      const text = typeof message.payload.text === "string" ? message.payload.text : "";
      history.push({ role: "user", content: text });
      lastUserEvent = message;
      if (live) {
        respondTo(message, history.slice());
      }
    } else if (message.type === "assistant.completed") {
      const text = typeof message.payload.text === "string" ? message.payload.text : "";
      if (text) {
        history.push({ role: "assistant", content: text });
      }
      lastAnswerSeq = Math.max(lastAnswerSeq, message.seq);
    } else if (live && (message.type === "host.beat" || message.type === "host.hello")) {
      const sender =
        typeof message.payload.instanceId === "string" ? message.payload.instanceId : "";
      if (sender) {
        lease.observe(sender, message.type === "host.beat" ? "beat" : "hello", Date.now());
      }
    }
  });
}

console.log(
  `trevor-host ${PARTICIPANT_ID} starting; session=${SESSION_ID} providers=qwen,gpt default=${DEFAULT_PROVIDER}`,
);
ensureSession()
  .then(() => connect())
  .catch((error) => {
    console.error("startup failed:", error);
    process.exit(1);
  });
