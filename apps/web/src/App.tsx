import { useQuery } from "@tanstack/react-query";
import { useInterval, useLocalStorageState } from "ahooks";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type SubmitEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  activeRunId,
  commandsFrom,
  FALLBACK_MODELS,
  fmtCtx,
  fmtTokens,
  hostStatus,
  isOverflowError,
  parseCommand,
  providerModelsFrom,
  QWEN_FALLBACK,
  tasksFrom,
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
// A prompt waiting in the local send queue, carrying the provider/reasoning chosen
// when it was submitted so a model switch while it waits doesn't rewrite it. The id
// is a stable React key (queue order can change when ESC-steer prepends).
type QueuedPrompt = { id: string; text: string; provider: string; reasoning?: string };

// Fold queued prompts (in order) and the current draft into one steering prompt.
// Cancelling collapses everything the user has lined up into a single interruption,
// rather than replaying queued prompts one at a time after the steer.
function combineSteer(queue: readonly QueuedPrompt[], draft: string): string {
  return [...queue.map((q) => q.text), draft.trim()].filter(Boolean).join("\n\n");
}
// Checklist row glyph + color by status (matches the V1 task set).
const TASK_ICON: Record<string, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
  failed: "✗",
  cancelled: "⊘",
};
const TASK_COLOR: Record<string, string> = {
  pending: "#555",
  in_progress: "#2a7",
  completed: "#9a9a9a",
  failed: "#c0392b",
  cancelled: "#9a9a9a",
};
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

  const { events, status, replayed, publish, cancel, command } = useRichterSession(sessionId);
  // These scan the whole event log; without memoizing, every keystroke in the draft
  // input (and the 4s clock tick) would rebuild them. host depends on now; the others
  // only on events, so they skip the tick.
  const transcript = useMemo(() => toTranscript(events), [events]);
  const awaitingResponse = transcript.at(-1)?.kind === "user";
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 4000);
  const host = useMemo(() => hostStatus(events, now), [events, now]);
  const hostModels = useMemo(() => providerModelsFrom(events), [events]);
  const active = useMemo(() => activeRunId(events), [events]);

  // The agent's live task checklist (host-published snapshots), rendered in the header.
  const tasks = useMemo(() => tasksFrom(events), [events]);
  const [tasksOpen, setTasksOpen] = useState(true);

  // Immediate host commands the host announced, plus the set of names used to tell a
  // command from an ordinary prompt at submit time.
  const commands = useMemo(() => commandsFrom(events), [events]);
  const commandNames = useMemo(() => new Set(commands.map((c) => c.name)), [commands]);
  // Slash menu: open while the draft is a bare "/token" (no space yet) with matches,
  // unless Esc dismissed it for exactly this text. menuIndex is the highlighted row.
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissedFor, setMenuDismissedFor] = useState<string | null>(null);
  const slashQuery = draft.startsWith("/") && !draft.includes(" ") ? draft : null;
  const menuMatches = useMemo(
    () => (slashQuery ? commands.filter((c) => c.name.startsWith(slashQuery)) : []),
    [slashQuery, commands],
  );
  const menuOpen = menuMatches.length > 0 && slashQuery !== null && draft !== menuDismissedFor;
  const menuIdx = Math.min(menuIndex, menuMatches.length - 1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset highlight when the filter changes.
  useEffect(() => setMenuIndex(0), [slashQuery]);
  const acceptCommand = (name: string) => {
    setDraft(`${name} `);
    inputRef.current?.focus();
  };
  // Focus the composer on load, once the session resolves and the input is enabled.
  useEffect(() => {
    if (sessionId) {
      inputRef.current?.focus();
    }
  }, [sessionId]);

  // Local send queue: a prompt submitted while a turn is in flight waits here and is
  // published only once the session is idle, so the host never receives two prompts
  // at once (which would run concurrent, out-of-order turns) and the event log stays
  // cleanly paired. ESC-steer prepends, so an interruption preempts what's waiting.
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const busy = active !== null || awaitingResponse;
  // inFlight bridges the window between publishing a prompt and seeing its echo turn
  // the session busy, so the drain effect can't fire twice and double-send. prevBusy
  // catches the turn-ended edge (busy high -> low) to release the latch.
  const inFlightRef = useRef(false);
  const prevBusyRef = useRef(busy);

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

  // A known slash command routes to the immediate host lane (runs now, bypassing the
  // model and the queue). Everything else enqueues; the drain effect publishes when
  // idle, so a second prompt during a turn waits its turn instead of firing at once.
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) {
      return;
    }
    const cmd = parseCommand(text, commandNames);
    if (cmd) {
      setDraft("");
      void command(cmd.command, cmd.args);
      return;
    }
    setDraft("");
    setQueue((q) => [
      ...q,
      {
        id: crypto.randomUUID(),
        text,
        provider: activeProvider,
        reasoning: reasoning || undefined,
      },
    ]);
  };

  // Slash-menu key handling on the composer, active only while the menu is open:
  // arrows move the highlight, Tab/Enter complete it, Esc dismisses (and is swallowed
  // so the window ESC cancel/steer handler doesn't also fire). An exact match + Enter
  // falls through to submit, so a fully-typed command runs on one Enter.
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const selected = menuOpen ? menuMatches[menuIdx] : undefined;
    if (!selected) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMenuIndex((i) => (i + 1) % menuMatches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMenuIndex((i) => (i - 1 + menuMatches.length) % menuMatches.length);
    } else if (event.key === "Tab") {
      event.preventDefault();
      acceptCommand(selected.name);
    } else if (event.key === "Enter") {
      if (selected.name !== draft) {
        event.preventDefault();
        acceptCommand(selected.name);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuDismissedFor(draft);
    }
  };

  // Release the in-flight latch when a turn ends (busy goes high then low), so the
  // next queued prompt becomes eligible to publish. Runs before the drain effect.
  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      inFlightRef.current = false;
    }
    prevBusyRef.current = busy;
  }, [busy]);

  // Drain one prompt at a time: publish the head only when idle and nothing is in
  // flight. Removing the head and latching inFlight before the echo arrives keeps a
  // re-render from publishing the next prompt early.
  useEffect(() => {
    if (busy || inFlightRef.current || queue.length === 0) {
      return;
    }
    const next = queue[0];
    if (!next) {
      return;
    }
    inFlightRef.current = true;
    setQueue((q) => q.slice(1));
    void publish(next.text, next.provider, next.reasoning);
  }, [busy, queue, publish]);

  // Hard steer: abort the active turn and fold queued prompts + draft into ONE
  // steering prompt that runs next. The single steer replaces the queue, so the
  // cancelled turn is followed by one combined interruption (not a replay of the
  // queue). It publishes only once the cancel resolves the turn (busy -> idle),
  // keeping the cancel strictly ahead of the steer.
  const onCancel = () => {
    const runId = active ?? (awaitingResponse ? "" : null);
    const steer = combineSteer(queue, draft);
    setDraft("");
    setQueue(
      steer
        ? [
            {
              id: crypto.randomUUID(),
              text: steer,
              provider: activeProvider,
              reasoning: reasoning || undefined,
            },
          ]
        : [],
    );
    if (runId !== null) {
      void cancel(runId);
    }
  };
  // The cancel button is live whenever there's a turn to abort (active or pending).
  const canCancel = busy;

  // ESC mirrors the cancel button when a run is active/pending; with nothing to
  // cancel it just clears the composer. One window listener reads the latest state
  // from a ref so it never goes stale and works regardless of which element has focus.
  const escRef = useRef({ active, awaiting: awaitingResponse, draft, setDraft, onCancel });
  escRef.current = { active, awaiting: awaitingResponse, draft, setDraft, onCancel };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const s = escRef.current;
      const runId = s.active ?? (s.awaiting ? "" : null);
      if (runId !== null) {
        event.preventDefault();
        s.onCancel();
      } else if (s.draft) {
        event.preventDefault();
        s.setDraft("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The composer is pinned to the bottom and the log scrolls above it. Auto-stick to
  // the newest line as content grows, unless the user has scrolled up to read back.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on each new event/queue entry.
  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, queue, stickToBottom]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) {
      setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    }
  };

  return (
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "0 1rem",
        fontFamily: "system-ui",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Fixed top: title, controls, and session/host status stay put while the log scrolls. */}
      <div style={{ flexShrink: 0, paddingTop: "1rem" }}>
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

        {/* The agent's live checklist (ambient + UI-reflected). Collapsible; auto-clears
            when the host wipes a finished list, since the snapshot then comes back empty. */}
        {tasks.length > 0 ? (
          <div style={{ margin: "0.5rem 0", fontSize: "0.85rem" }}>
            <button
              type="button"
              onClick={() => setTasksOpen((open) => !open)}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                cursor: "pointer",
                color: "#555",
                fontSize: "0.8rem",
                fontWeight: 600,
              }}
            >
              {tasksOpen ? "▾" : "▸"} Tasks {tasks.filter((t) => t.status === "completed").length}/
              {tasks.length}
            </button>
            {tasksOpen ? (
              <div
                style={{
                  marginTop: "0.3rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.15rem",
                }}
              >
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    style={{ display: "flex", gap: "0.45rem", alignItems: "baseline" }}
                  >
                    <span style={{ color: TASK_COLOR[task.status] ?? "#555" }}>
                      {TASK_ICON[task.status] ?? "•"}
                    </span>
                    <span
                      style={{
                        color: task.status === "completed" ? "#9a9a9a" : "#333",
                        textDecoration: task.status === "completed" ? "line-through" : "none",
                      }}
                    >
                      {task.activeForm}
                      {task.blockedBy.length > 0 ? (
                        <span style={{ color: "#bbb", fontSize: "0.75rem" }}>
                          {" "}
                          (blocked by {task.blockedBy.join(", ")})
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Scrollable region: only the transcript scrolls, between the fixed header and composer. */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto" }}>
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
            if (message.kind === "command") {
              return (
                <div key={message.id} style={{ margin: "0.75rem 0" }}>
                  <div style={{ fontSize: "0.72rem", color: "#999" }}>you</div>
                  <code style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" }}>
                    {message.args ? `${message.command} ${message.args}` : message.command}
                  </code>
                </div>
              );
            }
            if (message.kind === "result") {
              return (
                <div key={message.id} style={{ margin: "0.75rem 0" }}>
                  <div style={{ fontSize: "0.72rem", color: message.ok ? "#999" : "#c0392b" }}>
                    {message.command}
                    {message.ok ? "" : " · failed"}
                  </div>
                  <pre
                    style={{
                      margin: "0.2rem 0",
                      padding: "0.5rem 0.7rem",
                      background: "#f6f6f6",
                      border: "1px solid #eee",
                      borderRadius: 6,
                      fontSize: "0.8rem",
                      whiteSpace: "pre-wrap",
                      overflowX: "auto",
                      fontFamily: "ui-monospace, monospace",
                    }}
                  >
                    {message.text}
                  </pre>
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

            const cancelledNote =
              message.kind === "assistant" && message.cancelled ? (
                <div style={{ fontSize: "0.75rem", color: "#888", margin: "0.3rem 0" }}>
                  ⊘ cancelled
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
              message.kind === "user"
                ? "you"
                : message.done
                  ? "assistant"
                  : "assistant · streaming";
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
                {cancelledNote}
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

          {/* Prompts held in the local queue: shown muted as "queued" so they read as
            waiting, not sent, until the current turn frees up and they publish. */}
          {queue.map((q) => (
            <div key={q.id} style={{ margin: "0.75rem 0", opacity: 0.5 }}>
              <div style={{ fontSize: "0.72rem", color: "#999" }}>you · queued</div>
              <Markdown text={q.text} muted />
            </div>
          ))}
        </div>
      </div>

      {/* Pinned composer: the input bar stays at the bottom; the log above scrolls. */}
      <div
        style={{ flexShrink: 0, paddingTop: "0.5rem", paddingBottom: "1rem", background: "#fff" }}
      >
        {/* Slash menu: filters the host's announced command inventory as you type a
            leading "/". Arrows/Tab/Enter pick a row (handled on the input); a row click
            fills the composer. onMouseDown (not onClick) so the input keeps focus. */}
        {menuOpen ? (
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 6,
              marginTop: "0.75rem",
              overflow: "hidden",
            }}
          >
            {menuMatches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptCommand(c.name);
                }}
                style={{
                  display: "flex",
                  width: "100%",
                  gap: "0.6rem",
                  alignItems: "baseline",
                  padding: "0.35rem 0.6rem",
                  border: "none",
                  textAlign: "left",
                  font: "inherit",
                  background: i === menuIdx ? "#eef3ff" : "#fff",
                  cursor: "pointer",
                }}
              >
                <code style={{ fontWeight: 600, fontSize: "0.82rem" }}>{c.usage ?? c.name}</code>
                <span style={{ color: "#888", fontSize: "0.78rem" }}>{c.summary}</span>
              </button>
            ))}
          </div>
        ) : null}

        <form
          onSubmit={onSubmit}
          style={{ display: "flex", gap: "0.5rem", marginTop: menuOpen ? "0.4rem" : 0 }}
        >
          {/* Hard-steer control, left of the composer: aborts the active turn and folds
            any queued prompts + draft into one steering message. Mirrors ESC. */}
          <button
            type="button"
            onClick={onCancel}
            disabled={!canCancel}
            title="Cancel the active turn (folds queued prompts + draft into one steering message)"
            style={{
              padding: "0.5rem 0.7rem",
              color: canCancel ? "#c0392b" : "#bbb",
              borderColor: canCancel ? "#c0392b" : "#ddd",
              cursor: canCancel ? "pointer" : "default",
            }}
          >
            ⊘ Cancel
          </button>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={`message ${modelMeta.label}… (/ for commands)`}
            disabled={!sessionId}
            style={{ flex: 1, padding: "0.5rem" }}
          />
          <button type="submit" disabled={!sessionId}>
            Send
          </button>
        </form>
      </div>
    </main>
  );
}
