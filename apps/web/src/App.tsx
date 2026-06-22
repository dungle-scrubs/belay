import { useQuery } from "@tanstack/react-query";
import type { SessionEvent } from "@trevor/richter";
import { useLocalStorageState } from "ahooks";
import { type FormEvent, useState } from "react";
import { ensureSession } from "./richter/client";
import { useRichterSession } from "./richter/use-richter-session";

const PROVIDER_KEY = "trevor.provider";
// Host and browser default to one shared session so they auto-attach with no
// manual wiring; override with ?session=<id> in the URL.
const DEFAULT_SESSION = "trevor-local";
const rawString = { serializer: (value: string) => value, deserializer: (value: string) => value };

type AssistantMessage = {
  kind: "assistant";
  id: string;
  text: string;
  done: boolean;
  warm: boolean;
  model: string;
};
type ToolMessage = { kind: "tool"; id: string; name: string; args: string; done: boolean };
type Message = { kind: "user"; id: string; text: string } | AssistantMessage | ToolMessage;

/** Coalesces the raw event log into a transcript; assistant/tool grouped by run. */
function toTranscript(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  const assistantByRun = new Map<string, AssistantMessage>();
  const toolByCall = new Map<string, ToolMessage>();
  const ensureAssistant = (runId: string, payload: Record<string, unknown>): AssistantMessage => {
    let message = assistantByRun.get(runId);
    if (!message) {
      message = {
        kind: "assistant",
        id: runId,
        text: "",
        done: false,
        warm: payload.warm === true,
        model: typeof payload.model === "string" ? payload.model : "model",
      };
      assistantByRun.set(runId, message);
      messages.push(message);
    }
    return message;
  };
  for (const event of events) {
    const payload = event.payload;
    if (event.type === "user.message") {
      messages.push({ kind: "user", id: event.eventId, text: String(payload.text ?? "") });
    } else if (event.type === "assistant.started") {
      ensureAssistant(String(payload.runId ?? event.eventId), payload);
    } else if (event.type === "assistant.delta") {
      ensureAssistant(String(payload.runId ?? event.eventId), payload).text += String(
        payload.text ?? "",
      );
    } else if (event.type === "assistant.completed") {
      const message = ensureAssistant(String(payload.runId ?? event.eventId), payload);
      message.done = true;
      if (!message.text) {
        message.text = String(payload.text ?? "");
      }
    } else if (event.type === "tool.started") {
      const callId = String(payload.callId ?? event.eventId);
      const message: ToolMessage = {
        kind: "tool",
        id: callId,
        name: String(payload.name ?? "tool"),
        args: String(payload.arguments ?? ""),
        done: false,
      };
      toolByCall.set(callId, message);
      messages.push(message);
    } else if (event.type === "tool.completed") {
      const message = toolByCall.get(String(payload.callId ?? event.eventId));
      if (message) {
        message.done = true;
      }
    }
  }
  return messages;
}

export function App() {
  const target = new URLSearchParams(window.location.search).get("session") ?? DEFAULT_SESSION;
  const sessionQuery = useQuery({
    queryKey: ["richter-session", target],
    queryFn: async () => {
      await ensureSession(target);
      return target;
    },
  });
  const sessionId = sessionQuery.data ?? null;

  const [provider, setProvider] = useLocalStorageState<string>(PROVIDER_KEY, {
    ...rawString,
    defaultValue: "qwen",
  });
  const [draft, setDraft] = useState("");

  const { events, status, replayed, publish } = useRichterSession(sessionId);
  const transcript = toTranscript(events);
  const awaitingResponse = transcript.at(-1)?.kind === "user";
  const hostSeen = events.some((event) => event.type === "host.online");
  const hostCommand =
    target === DEFAULT_SESSION
      ? "pnpm --filter @trevor/agent-host start"
      : `SESSION_ID=${target} pnpm --filter @trevor/agent-host start`;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft("");
    await publish(text, provider ?? "qwen");
  };

  return (
    <main
      style={{ maxWidth: 760, margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui" }}
    >
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h1>Trevor</h1>
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          style={{ padding: "0.3rem 0.4rem" }}
        >
          <option value="qwen">Qwen (local)</option>
          <option value="gpt">GPT-5.5</option>
        </select>
      </header>

      <p style={{ color: "#666" }}>
        session <code>{target}</code> · {status}
        {replayed ? " · replayed" : ""} · {events.length} events
      </p>

      {sessionId && !hostSeen ? (
        <p style={{ color: "#a60", fontSize: "0.8rem" }}>
          No host on this session yet. Start one: <code>{hostCommand}</code>
        </p>
      ) : null}

      <div>
        {transcript.map((message) => {
          if (message.kind === "tool") {
            const args = message.args.length > 60 ? `${message.args.slice(0, 60)}…` : message.args;
            return (
              <div
                key={message.id}
                style={{
                  margin: "0.4rem 0",
                  fontSize: "0.78rem",
                  color: "#777",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                🔧 {message.name}({args}) {message.done ? "✓" : "…"}
              </div>
            );
          }
          if (message.kind === "assistant" && !message.text && !message.done) {
            const pending = message.warm ? "thinking…" : `loading ${message.model}…`;
            return (
              <div key={message.id} style={{ margin: "0.75rem 0" }}>
                <div style={{ fontSize: "0.72rem", color: "#999" }}>assistant</div>
                <div style={{ color: "#999", fontStyle: "italic" }}>{pending}</div>
              </div>
            );
          }
          const label =
            message.kind === "user" ? "you" : message.done ? "assistant" : "assistant · streaming";
          return (
            <div key={message.id} style={{ margin: "0.75rem 0" }}>
              <div style={{ fontSize: "0.72rem", color: "#999" }}>{label}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div>
            </div>
          );
        })}

        {awaitingResponse ? (
          <div style={{ margin: "0.75rem 0" }}>
            <div style={{ fontSize: "0.72rem", color: "#999" }}>assistant</div>
            <div style={{ color: "#999", fontStyle: "italic" }}>thinking…</div>
          </div>
        ) : null}
      </div>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={provider === "gpt" ? "message GPT-5.5…" : "message qwen…"}
          disabled={!sessionId}
          style={{ flex: 1, padding: "0.5rem" }}
        />
        <button type="submit" disabled={!sessionId}>
          Send
        </button>
      </form>
    </main>
  );
}
