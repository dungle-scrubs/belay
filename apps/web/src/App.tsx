import { useQuery } from "@tanstack/react-query";
import { useInterval, useLocalStorageState } from "ahooks";
import { type SubmitEvent, useMemo, useState } from "react";
import {
  FALLBACK_MODELS,
  fmtCtx,
  fmtTokens,
  hostStatus,
  isOverflowError,
  providerModelsFrom,
  QWEN_FALLBACK,
  toolSummary,
} from "./derive";
import { Markdown } from "./markdown";
import { ensureSession } from "./richter/client";
import { useRichterSession } from "./richter/use-richter-session";
import { toTranscript } from "./transcript";

const PROVIDER_KEY = "trevor.provider";
// Per-provider chosen reasoning level, and whether to render thinking text at all.
const REASONING_KEY = "trevor.reasoning";
const SHOW_THINKING_KEY = "trevor.showThinking";
// Host and browser default to one shared session so they auto-attach with no
// manual wiring; override with ?session=<id> in the URL.
const DEFAULT_SESSION = "trevor-local";
const rawString = { serializer: (value: string) => value, deserializer: (value: string) => value };

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
  const [reasoningMap, setReasoningMap] = useLocalStorageState<Record<string, string>>(
    REASONING_KEY,
    { defaultValue: {} },
  );
  const [showThinking, setShowThinking] = useLocalStorageState<boolean>(SHOW_THINKING_KEY, {
    defaultValue: true,
  });
  const [draft, setDraft] = useState("");

  const { events, status, replayed, publish } = useRichterSession(sessionId);
  // These scan the whole event log; without memoizing, every keystroke in the draft
  // input (and the 4s clock tick) would rebuild them. host depends on now; the others
  // only on events, so they skip the tick.
  const transcript = useMemo(() => toTranscript(events), [events]);
  const awaitingResponse = transcript.at(-1)?.kind === "user";
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 4000);
  const host = useMemo(() => hostStatus(events, now), [events, now]);
  const hostModels = useMemo(() => providerModelsFrom(events), [events]);

  const activeProvider = provider ?? "qwen";
  const modelMeta = hostModels[activeProvider] ?? FALLBACK_MODELS[activeProvider] ?? QWEN_FALLBACK;
  // Keep a stale stored level from showing as selected if the model's options changed.
  const stored = reasoningMap?.[activeProvider];
  const reasoning =
    stored && modelMeta.reasoningLevels.includes(stored) ? stored : modelMeta.defaultReasoning;
  const showThinkingOn = showThinking ?? true;
  const setReasoning = (level: string) =>
    setReasoningMap({ ...(reasoningMap ?? {}), [activeProvider]: level });

  const hostCommand =
    target === DEFAULT_SESSION
      ? "pnpm --filter @trevor/agent-host start"
      : `SESSION_ID=${target} pnpm --filter @trevor/agent-host start`;

  const onSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft("");
    await publish(text, activeProvider, reasoning || undefined);
  };

  return (
    <main
      style={{ maxWidth: 760, margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui" }}
    >
      <header
        style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}
      >
        <h1>Trevor</h1>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
            alignItems: "flex-end",
          }}
        >
          <select
            value={activeProvider}
            onChange={(event) => setProvider(event.target.value)}
            style={{ padding: "0.3rem 0.4rem" }}
          >
            {/* Options come from the host's announced providers, so adding one host-side
                surfaces here with no UI edit; the fallback covers the pre-announce window. */}
            {Object.entries(hostModels).map(([key, meta]) => (
              <option key={key} value={key}>
                {meta.label}
              </option>
            ))}
          </select>

          {modelMeta.reasoningLevels.length > 0 ? (
            <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
              <span style={{ fontSize: "0.7rem", color: "#999" }}>reasoning</span>
              {modelMeta.reasoningLevels.map((level) => {
                const active = level === reasoning;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setReasoning(level)}
                    style={{
                      fontSize: "0.72rem",
                      padding: "0.15rem 0.4rem",
                      borderRadius: 4,
                      border: active ? "1px solid #2a7" : "1px solid #ccc",
                      background: active ? "#2a7" : "#fff",
                      color: active ? "#fff" : "#555",
                      cursor: "pointer",
                    }}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
          ) : null}

          <label
            style={{
              fontSize: "0.72rem",
              color: "#777",
              display: "flex",
              gap: "0.3rem",
              alignItems: "center",
            }}
          >
            <input
              type="checkbox"
              checked={showThinkingOn}
              onChange={(event) => setShowThinking(event.target.checked)}
            />
            show thinking
          </label>
        </div>
      </header>

      <p style={{ color: "#666" }}>
        session <code>{target}</code> · {status}
        {replayed ? " · replayed" : ""} · {events.length} events
      </p>

      {sessionId ? (
        <p style={{ fontSize: "0.8rem", margin: "0.2rem 0" }}>
          {host.leaderId ? (
            <span style={{ color: "#2a7" }}>
              ● host active
              {host.standbyCount > 0
                ? ` (${host.leaderId.slice(0, 8)}) · ${host.standbyCount} standby`
                : ""}
            </span>
          ) : host.present ? (
            <span style={{ color: "#a60" }}>● host starting…</span>
          ) : (
            <span style={{ color: "#a60" }}>
              ● no host on this session — start one: <code>{hostCommand}</code>
            </span>
          )}
        </p>
      ) : null}

      {host.workspace ? (
        <p style={{ color: "#888", fontSize: "0.78rem", margin: "0.2rem 0" }}>
          workspace <code>{host.workspace}</code>
          {host.cwd && host.cwd !== host.workspace ? (
            <>
              {" · cwd "}
              <code>{host.cwd}</code>
            </>
          ) : null}
        </p>
      ) : null}

      <div>
        {transcript.map((message) => {
          if (message.kind === "tool") {
            const args = toolSummary(message.name, message.args);
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
          const thinking =
            message.kind === "assistant" && showThinkingOn && message.thinking
              ? message.thinking
              : null;
          const overflowNote =
            message.kind === "assistant" && message.overflow ? (
              <div style={{ fontSize: "0.75rem", color: "#b26a00", margin: "0.3rem 0" }}>
                ⚠ context overflow — {message.overflow}
              </div>
            ) : null;
          const errorNote =
            message.kind === "assistant" && message.error ? (
              <div style={{ fontSize: "0.75rem", color: "#c0392b", margin: "0.3rem 0" }}>
                ⚠{" "}
                {isOverflowError(message.error)
                  ? `context overflow — ${message.error}`
                  : message.error}
              </div>
            ) : null;
          if (message.kind === "assistant" && !message.text && !message.done) {
            return (
              <div key={message.id} style={{ margin: "0.75rem 0" }}>
                <div style={{ fontSize: "0.72rem", color: "#999" }}>assistant</div>
                {thinking ? (
                  <Markdown text={thinking} muted />
                ) : (
                  <div style={{ color: "#999", fontStyle: "italic" }}>
                    {message.warm ? "thinking…" : `loading ${message.model}…`}
                  </div>
                )}
                {overflowNote}
                {errorNote}
              </div>
            );
          }
          const label =
            message.kind === "user" ? "you" : message.done ? "assistant" : "assistant · streaming";
          // Meta (model · context · speed) rides on the final segment - the one that
          // carries usage - so it isn't repeated under every pre-tool segment.
          let meta: string | null = null;
          if (message.kind === "assistant" && message.usage) {
            const usage = message.usage;
            const parts = [
              message.model,
              `${fmtTokens(usage.input)}/${fmtCtx(usage.contextWindow)} ctx`,
            ];
            if (usage.genMs > 0) {
              parts.push(`${Math.round(usage.output / (usage.genMs / 1000))} tok/s`);
            }
            meta = parts.join(" · ");
          }
          return (
            <div key={message.id} style={{ margin: "0.75rem 0" }}>
              <div style={{ fontSize: "0.72rem", color: "#999" }}>{label}</div>
              {thinking ? <Markdown text={thinking} muted /> : null}
              {message.text ? <Markdown text={message.text} /> : null}
              {overflowNote}
              {errorNote}
              {meta ? (
                <div style={{ fontSize: "0.68rem", color: "#aaa", marginTop: "0.2rem" }}>
                  {meta}
                </div>
              ) : null}
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
          placeholder={`message ${modelMeta.label}…`}
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
