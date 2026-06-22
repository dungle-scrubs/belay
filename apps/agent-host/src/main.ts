import { decodeServerEnvelope, type SessionEvent } from "@trevor/richter";
import { Either } from "effect";
import { buildProviders, DEFAULT_PROVIDER, type Provider } from "./providers";

/**
 * Trevor host (Slice 3): a Richter participant that streams real completions for
 * each new user.message via a per-message-selectable Provider - local LM Studio
 * (qwen) or GPT-5.x over Codex OAuth (gpt), chosen by the browser dropdown and
 * carried on user.message.payload.provider. It gates on replay, answers the latest
 * pending prompt on go-live, and reports model readiness (cold vs warm) per turn.
 */

const SERVICE_URL = process.env.RICHTER_URL ?? "http://localhost:3025";
const SESSION_ID = process.env.SESSION_ID;
const PRODUCER_ID = "trevor-host";
const DELTA_FLUSH_CHARS = 40;
const providers = buildProviders();

interface ConnectionState {
  live: boolean;
  lastUserEvent: SessionEvent | null;
  lastAnswerSeq: number;
}

if (!SESSION_ID) {
  console.error("set SESSION_ID to the Richter session to join");
  process.exit(1);
}

/** Resolves the provider key the browser chose to a concrete provider. */
function pickProvider(key: unknown): Provider {
  return key === "gpt" ? providers.gpt : providers.qwen;
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

/** Streams a provider completion as assistant.started -> delta* -> completed. */
async function streamCompletion(
  sessionId: string,
  prompt: string,
  providerKey: unknown,
): Promise<void> {
  const runId = crypto.randomUUID();
  const provider = pickProvider(providerKey);
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
    for await (const chunk of provider.stream(prompt)) {
      pending += chunk;
      full += chunk;
      if (pending.length >= DELTA_FLUSH_CHARS) {
        await flush();
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

/** Streams a completion for a user.message (not our own), on its chosen provider. */
function respondTo(sessionId: string, event: SessionEvent): void {
  if (event.type !== "user.message" || event.producerId === PRODUCER_ID) {
    return;
  }
  const prompt = typeof event.payload.text === "string" ? event.payload.text : "";
  streamCompletion(sessionId, prompt, event.payload.provider).catch((error) =>
    console.error("completion error:", error),
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
    respondTo(sessionId, state.lastUserEvent); // answer a prompt sent before we joined
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
  const state: ConnectionState = { live: false, lastUserEvent: null, lastAnswerSeq: -1 };
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
    if (state.live) {
      respondTo(sessionId, message);
      return;
    }
    // During replay, track the latest prompt + answer to decide catch-up on go-live.
    if (message.type === "user.message" && message.producerId !== PRODUCER_ID) {
      state.lastUserEvent = message;
    } else if (message.type === "assistant.completed") {
      state.lastAnswerSeq = Math.max(state.lastAnswerSeq, message.seq);
    }
  });
}

connect(SESSION_ID);
console.log(`trevor-host up; providers=qwen,gpt default=${DEFAULT_PROVIDER}`);
