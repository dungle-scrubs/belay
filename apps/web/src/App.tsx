import { useQuery } from "@tanstack/react-query";
import type { SessionEvent } from "@trevor/richter";
import { useInterval, useLocalStorageState } from "ahooks";
import { type SubmitEvent, useState } from "react";
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

/** A provider's model id + the thinking options the UI should surface for it. */
type ProviderModel = {
  model: string;
  reasoningLevels: string[];
  defaultReasoning: string;
};

// Used until the host announces itself: qwen is binary, GPT graduated.
const QWEN_FALLBACK: ProviderModel = {
  model: "qwen",
  reasoningLevels: ["off", "on"],
  defaultReasoning: "off",
};
const FALLBACK_MODELS: Record<string, ProviderModel> = {
  qwen: QWEN_FALLBACK,
  gpt: {
    model: "GPT-5.5",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
    defaultReasoning: "medium",
  },
};

type HostStatus = {
  present: boolean;
  leaderId: string | null;
  standbyCount: number;
  workspace: string | null;
  cwd: string | null;
};

/** Compact token count: 6100 -> "6.1k", 812 -> "812". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Compact context window: 8192 -> "8k", 0/unknown -> "?". */
function fmtCtx(n: number): string {
  if (n <= 0) {
    return "?";
  }
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** A standby pings continuously, so it counts as present only if seen this recently. */
const HOST_RECENT_MS = 15000;

/**
 * Derives host presence from the lease's host.* events. The current leader is the
 * host whose latest role is "leader" - shown as last-known, since a lone leader
 * goes silent. A standby pings every heartbeat, so live standbys are those seen
 * within HOST_RECENT_MS (excluding the leader); stale ids from dead hosts drop off.
 */
function hostStatus(events: readonly SessionEvent[], nowMs: number): HostStatus {
  let present = false;
  let workspace: string | null = null;
  let cwd: string | null = null;
  const role = new Map<string, string>();
  const lastSeen = new Map<string, number>();
  for (const event of events) {
    if (event.type === "host.online") {
      present = true;
      if (typeof event.payload.workspace === "string") {
        workspace = event.payload.workspace;
      }
      if (typeof event.payload.cwd === "string") {
        cwd = event.payload.cwd;
      }
    }
    if (
      event.type === "host.online" ||
      event.type === "host.hello" ||
      event.type === "host.beat" ||
      event.type === "host.role"
    ) {
      const id = event.payload.instanceId;
      if (typeof id !== "string") {
        continue;
      }
      const at = Date.parse(event.createdAt);
      lastSeen.set(id, Number.isNaN(at) ? nowMs : at);
      if (event.type === "host.role" && typeof event.payload.role === "string") {
        role.set(id, event.payload.role);
      }
    }
  }
  let leaderId: string | null = null;
  let leaderSeen = Number.NEGATIVE_INFINITY;
  for (const [id, value] of role) {
    const seen = lastSeen.get(id) ?? Number.NEGATIVE_INFINITY;
    if (value === "leader" && seen >= leaderSeen) {
      leaderSeen = seen;
      leaderId = id;
    }
  }
  let standbyCount = 0;
  for (const [id, at] of lastSeen) {
    if (id !== leaderId && nowMs - at < HOST_RECENT_MS) {
      standbyCount += 1;
    }
  }
  return { present, leaderId, standbyCount, workspace, cwd };
}

/** The latest per-provider model/reasoning map the host announced, else the fallback. */
function providerModelsFrom(events: readonly SessionEvent[]): Record<string, ProviderModel> {
  let latest: Record<string, ProviderModel> | null = null;
  for (const event of events) {
    if (event.type !== "host.online") {
      continue;
    }
    const raw = event.payload.models;
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const parsed: Record<string, ProviderModel> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const v = value as Record<string, unknown>;
      const levels = Array.isArray(v.reasoningLevels)
        ? v.reasoningLevels.filter((level): level is string => typeof level === "string")
        : [];
      parsed[key] = {
        model: typeof v.model === "string" ? v.model : key,
        reasoningLevels: levels,
        defaultReasoning:
          typeof v.defaultReasoning === "string" ? v.defaultReasoning : (levels[0] ?? ""),
      };
    }
    latest = parsed;
  }
  return latest ?? FALLBACK_MODELS;
}

/** Whether a host error string looks like a context-overflow / token-limit failure. */
function isOverflowError(error: string): boolean {
  return /context|token limit|too long|too many tokens|maximum.*(context|tokens)|reduce the (length|size)/i.test(
    error,
  );
}

/** A concise, tool-aware label for a tool call (path/command/pattern, not the blob). */
function toolSummary(name: string, argsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return "";
  }
  const primary =
    name === "bash" ? args.command : name === "grep" || name === "glob" ? args.pattern : args.path;
  const text = typeof primary === "string" ? primary : argsJson;
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
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
  const [reasoningMap, setReasoningMap] = useLocalStorageState<Record<string, string>>(
    REASONING_KEY,
    { defaultValue: {} },
  );
  const [showThinking, setShowThinking] = useLocalStorageState<boolean>(SHOW_THINKING_KEY, {
    defaultValue: true,
  });
  const [draft, setDraft] = useState("");

  const { events, status, replayed, publish } = useRichterSession(sessionId);
  const transcript = toTranscript(events);
  const awaitingResponse = transcript.at(-1)?.kind === "user";
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 4000);
  const host = hostStatus(events, now);
  const hostModels = providerModelsFrom(events);

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
            <option value="qwen">Qwen (local)</option>
            <option value="gpt">GPT-5.5</option>
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
                  <div
                    style={{
                      color: "#999",
                      fontStyle: "italic",
                      whiteSpace: "pre-wrap",
                      fontSize: "0.85rem",
                    }}
                  >
                    {thinking}
                  </div>
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
              {thinking ? (
                <div
                  style={{
                    color: "#999",
                    fontStyle: "italic",
                    whiteSpace: "pre-wrap",
                    fontSize: "0.85rem",
                    marginBottom: "0.3rem",
                  }}
                >
                  {thinking}
                </div>
              ) : null}
              {message.text ? <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div> : null}
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
          placeholder={activeProvider === "gpt" ? "message GPT-5.5…" : "message qwen…"}
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
