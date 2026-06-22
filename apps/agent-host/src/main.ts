import { decodeServerEnvelope, type SessionEvent } from "@trevor/richter";
import { Either } from "effect";
import { runAgent } from "./agent/loop";
import { buildProviders, type ChatMessage, DEFAULT_PROVIDER, type Provider } from "./providers";

/**
 * Trevor host: a Richter participant that runs an agent loop (model <-> tools) for
 * each new user.message over the full conversation, via a per-message-selectable
 * Provider (local qwen with tool-calling, or GPT-5.x text-only over Codex OAuth).
 * It builds history from the event log, gates on replay, answers the latest pending
 * prompt on go-live, and reports cold/warm readiness. Defaults to a shared session
 * ("trevor-local") so host and browser auto-attach; override with SESSION_ID.
 */

const SERVICE_URL = process.env.RICHTER_URL ?? "http://localhost:3025";
const SESSION_ID = process.env.SESSION_ID ?? "trevor-local";
const PRODUCER_ID = "trevor-host";
const DELTA_FLUSH_CHARS = 40;
const providers = buildProviders();

interface ConnectionState {
  live: boolean;
  history: ChatMessage[];
  lastUserEvent: SessionEvent | null;
  lastAnswerSeq: number;
}

/** Resolves the provider key the browser chose to a concrete provider. */
function pickProvider(key: unknown): Provider {
  return key === "gpt" ? providers.gpt : providers.qwen;
}

/** Ensures the session exists (idempotent) so host and browser share a default. */
async function ensureSession(sessionId: string): Promise<void> {
  await fetch(`${SERVICE_URL}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

/** Builds the participant stream URL, mirroring Richter's query-param contract. */
function streamUrl(sessionId: string, afterSeq: number): string {
  const url = new URL(`/sessions/${sessionId}/stream`, SERVICE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("after", String(afterSeq));
  url.searchParams.set("capabilities", "{}");
  url.searchParams.set("displayName", "trevor-host");
  url.searchParams.set("instanceId", crypto.randomUUID());
  url.searchParams.set("participantId", PRODUCER_ID);
  url.searchParams.set("runtimeKind", "trevor");
  return url.toString();
}

/** Publishes one event to the durable log via REST. */
async function publish(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${SERVICE_URL}/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, producerId: PRODUCER_ID, payload }),
  });
  if (!response.ok) {
    throw new Error(`publish failed: HTTP ${response.status}`);
  }
}

/** Runs the agent loop for one turn, publishing text deltas and tool events. */
async function runTurn(
  sessionId: string,
  provider: Provider,
  history: readonly ChatMessage[],
): Promise<void> {
  const runId = crypto.randomUUID();
  const { warm } = await provider.readiness();
  await publish(sessionId, "assistant.started", {
    runId,
    warm,
    model: provider.model,
    provider: provider.id,
  });

  let pending = "";
  let full = "";
  const flush = async (): Promise<void> => {
    if (pending) {
      const text = pending;
      pending = "";
      await publish(sessionId, "assistant.delta", { runId, text });
    }
  };

  try {
    for await (const event of runAgent(provider, history)) {
      if (event.type === "text") {
        pending += event.text;
        full += event.text;
        if (pending.length >= DELTA_FLUSH_CHARS) {
          await flush();
        }
      } else if (event.type === "tool_start") {
        await flush();
        await publish(sessionId, "tool.started", {
          runId,
          callId: event.call.id,
          name: event.call.name,
          arguments: event.call.arguments,
        });
      } else {
        await publish(sessionId, "tool.completed", {
          runId,
          callId: event.call.id,
          name: event.call.name,
          result: event.result.slice(0, 4000),
        });
      }
    }
  } catch (error) {
    await flush();
    await publish(sessionId, "assistant.completed", {
      runId,
      text: full,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  await flush();
  await publish(sessionId, "assistant.completed", { runId, text: full });
}

/** Runs a turn for a user.message (not our own) on its chosen provider, with history. */
function respondTo(sessionId: string, event: SessionEvent, history: readonly ChatMessage[]): void {
  if (event.type !== "user.message" || event.producerId === PRODUCER_ID) {
    return;
  }
  runTurn(sessionId, pickProvider(event.payload.provider), history).catch((error) =>
    console.error("turn error:", error),
  );
}

/** On go-live: announce providers, answer a pending prompt, or pre-warm local. */
async function goLive(sessionId: string, state: ConnectionState): Promise<void> {
  console.log("replay complete; live");
  await publish(sessionId, "host.online", {
    providers: ["qwen", "gpt"],
    default: DEFAULT_PROVIDER,
  });
  if (state.lastUserEvent && state.lastUserEvent.seq > state.lastAnswerSeq) {
    respondTo(sessionId, state.lastUserEvent, state.history.slice()); // catch up a pending prompt
    return;
  }
  const { warm } = await providers.qwen.readiness();
  if (!warm) {
    providers.qwen.warm().catch((error) => console.error("warm error:", error)); // pre-warm local
  }
}

/** Connects to the session stream (replay-then-tail) with simple reconnect. */
function connect(sessionId: string): void {
  const socket = new WebSocket(streamUrl(sessionId, 0));
  const state: ConnectionState = {
    live: false,
    history: [],
    lastUserEvent: null,
    lastAnswerSeq: -1,
  };
  socket.addEventListener("open", () => console.log(`host joined session ${sessionId}`));
  socket.addEventListener("close", () => {
    console.log("socket closed; reconnecting in 1s");
    setTimeout(() => connect(sessionId), 1000);
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
      state.live = true;
      goLive(sessionId, state).catch((error) => console.error("goLive error:", error));
      return;
    }
    if (envelope.op !== "event") {
      return;
    }
    const message = envelope.event;
    if (message.type === "user.message" && message.producerId !== PRODUCER_ID) {
      const text = typeof message.payload.text === "string" ? message.payload.text : "";
      state.history.push({ role: "user", content: text });
      state.lastUserEvent = message;
      if (state.live) {
        respondTo(sessionId, message, state.history.slice());
      }
    } else if (message.type === "assistant.completed") {
      const text = typeof message.payload.text === "string" ? message.payload.text : "";
      if (text) {
        state.history.push({ role: "assistant", content: text });
      }
      state.lastAnswerSeq = Math.max(state.lastAnswerSeq, message.seq);
    }
  });
}

console.log(
  `trevor-host starting; session=${SESSION_ID} providers=qwen,gpt default=${DEFAULT_PROVIDER}`,
);
ensureSession(SESSION_ID)
  .then(() => connect(SESSION_ID))
  .catch((error) => {
    console.error("startup failed:", error);
    process.exit(1);
  });
