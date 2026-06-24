import { useQuery } from "@tanstack/react-query";
import type { ArtifactRef } from "@trevor/session";
import { useInterval, useLocalStorageState } from "ahooks";
import { Plus, X } from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SubmitEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ModelSelector } from "@/components/assistant-ui/model-selector";
import {
  CommandMessage,
  CommandResult,
  MessageMeta,
  ThinkingMessage,
  ToolCall,
  WorkingIndicator,
} from "@/components/chat/message";
import { MultiEditDiff } from "@/components/chat/multi-edit-diff";
import { ToolDiff } from "@/components/chat/tool-diff";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { ArtifactThumb } from "./ArtifactThumb";
import { uploadArtifact } from "./blob";
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
import { ensureSession } from "./session/client";
import { useSession } from "./session/use-session";
import { TasksPanel } from "./TasksPanel";
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
type QueuedPrompt = {
  id: string;
  text: string;
  provider: string;
  reasoning?: string;
  artifacts?: readonly ArtifactRef[];
};

// Fold queued prompts (in order) and the current draft into one steering prompt.
// Cancelling collapses everything the user has lined up into a single interruption,
// rather than replaying queued prompts one at a time after the steer.
function combineSteer(queue: readonly QueuedPrompt[], draft: string): string {
  return [...queue.map((q) => q.text), draft.trim()].filter(Boolean).join("\n\n");
}
const rawString = { serializer: (value: string) => value, deserializer: (value: string) => value };

// SMUI-themed markdown body: reuses the app's Markdown renderer, re-themed via the
// .smui-md scope in index.css.
function Md({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <div className={cn("smui-md text-sm", muted ? "text-muted-foreground" : "text-foreground")}>
      <Markdown text={text} muted={muted} />
    </div>
  );
}

// Tool-call arguments arrive as a JSON string; parse defensively (a streaming or
// malformed call yields {}).
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
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
  // Pending attachments: ArtifactRefs already uploaded to the blob store, waiting to ride
  // the next prompt. `uploading` counts in-flight uploads so the composer can show progress.
  const [attachments, setAttachments] = useState<readonly ArtifactRef[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { events, status, replayed, publish, cancel, command } = useSession(sessionId);
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
  // Refocus the composer whenever the tab/window regains focus.
  useEffect(() => {
    const focusInput = () => inputRef.current?.focus();
    window.addEventListener("focus", focusInput);
    return () => window.removeEventListener("focus", focusInput);
  }, []);

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
  // Model options for the picker; fall back to the active model before the host announces.
  const modelOptions =
    Object.keys(hostModels).length > 0
      ? Object.entries(hostModels).map(([id, meta]) => ({ id, name: meta.label }))
      : [{ id: activeProvider, name: modelMeta.label }];
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
    // A slash command (text only) routes to the immediate host lane. Otherwise a prompt
    // may carry text, attachments, or both - attachments-only is a valid "look at this".
    const cmd = text ? parseCommand(text, commandNames) : null;
    if (cmd) {
      setDraft("");
      void command(cmd.command, cmd.args);
      return;
    }
    if (!text && attachments.length === 0) {
      return;
    }
    setDraft("");
    const artifacts = attachments.length ? attachments : undefined;
    setAttachments([]);
    setQueue((q) => [
      ...q,
      {
        id: crypto.randomUUID(),
        text,
        provider: activeProvider,
        reasoning: reasoning || undefined,
        artifacts,
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
    void publish(next.text, next.provider, next.reasoning, next.artifacts);
  }, [busy, queue, publish]);

  // Hard steer: abort the active turn and fold queued prompts + draft into ONE
  // steering prompt that runs next. The single steer replaces the queue, so the
  // cancelled turn is followed by one combined interruption (not a replay of the
  // queue). It publishes only once the cancel resolves the turn (busy -> idle),
  // keeping the cancel strictly ahead of the steer.
  const onCancel = () => {
    const runId = active ?? (awaitingResponse ? "" : null);
    const steer = combineSteer(queue, draft);
    // Fold every queued/attached artifact into the single steering prompt too, so a hard
    // steer keeps the images the user lined up rather than silently dropping them.
    const steerArtifacts = [...queue.flatMap((q) => q.artifacts ?? []), ...attachments];
    setDraft("");
    setAttachments([]);
    setQueue(
      steer || steerArtifacts.length
        ? [
            {
              id: crypto.randomUUID(),
              text: steer,
              provider: activeProvider,
              reasoning: reasoning || undefined,
              artifacts: steerArtifacts.length ? steerArtifacts : undefined,
            },
          ]
        : [],
    );
    if (runId !== null) {
      void cancel(runId);
    }
  };

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

  // No scroll JS: the transcript container is flex-col-reverse, so it sits at the
  // bottom (newest) from the first paint and stays pinned - no jump, no animation.

  // Attachments: upload each picked/pasted/dropped file to the blob store and hold its
  // ArtifactRef until the next prompt carries it. Uploads run in parallel; a failed one
  // simply doesn't attach. `uploading` brackets each so the composer can show progress.
  const addFiles = (files: Iterable<File>) => {
    setUploadError(null);
    for (const file of files) {
      setUploading((n) => n + 1);
      uploadArtifact(file)
        .then((ref) => setAttachments((a) => [...a, ref]))
        .catch((cause: unknown) => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          setUploadError(`couldn't attach ${file.name || "file"}: ${detail}`);
        })
        .finally(() => setUploading((n) => n - 1));
    }
  };
  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addFiles(event.target.files);
    }
    event.target.value = ""; // let the same file be re-picked
  };
  const onPaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files.length) {
      addFiles(event.dataTransfer.files);
    }
  };
  const removeAttachment = (hash: string) =>
    setAttachments((a) => a.filter((ref) => ref.hash !== hash));

  return (
    <main className="flex h-svh flex-col px-4">
      {/* Transcript fills the view; the composer + footer pin to the bottom.
          Scrollbar is hidden but the region still scrolls. */}
      <div className="flex flex-1 flex-col-reverse overflow-y-auto py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Nothing renders until the full history has replayed, then it appears all at
            once (already pinned to the bottom) with a 150ms fade-in. */}
        {replayed ? (
          <div className="flex flex-col gap-8 fade-in animate-in duration-150">
            {transcript.map((message) => {
              // multi_edit: one atomic operation, grouped by file as collapsible diffs.
              if (message.kind === "tool" && message.name === "multi_edit") {
                const a = parseToolArgs(message.args);
                const raw = Array.isArray(a.edits) ? a.edits : [];
                const edits = raw
                  .map((item) => {
                    const e = (item ?? {}) as Record<string, unknown>;
                    return {
                      path: typeof e.path === "string" ? e.path : "",
                      old: typeof e.old === "string" ? e.old : "",
                      new: typeof e.new === "string" ? e.new : "",
                    };
                  })
                  .filter((e) => e.path);
                if (edits.length > 0) {
                  return (
                    <MultiEditDiff
                      key={message.id}
                      className="pl-3.5"
                      edits={edits}
                      status={message.done ? "done" : "running"}
                    />
                  );
                }
              }
              // write/edit render as a code diff (up to 3 lines of subdued context).
              if (
                message.kind === "tool" &&
                (message.name === "write" || message.name === "edit")
              ) {
                const a = parseToolArgs(message.args);
                const path = typeof a.path === "string" ? a.path : "";
                if (path) {
                  const status = message.done ? "done" : "running";
                  return message.name === "write" ? (
                    <ToolDiff
                      key={message.id}
                      className="pl-3.5"
                      tool="write"
                      path={path}
                      newText={typeof a.content === "string" ? a.content : ""}
                      status={status}
                    />
                  ) : (
                    <ToolDiff
                      key={message.id}
                      className="pl-3.5"
                      tool="edit"
                      path={path}
                      oldText={typeof a.old === "string" ? a.old : ""}
                      newText={typeof a.new === "string" ? a.new : ""}
                      status={status}
                    />
                  );
                }
              }
              if (message.kind === "tool") {
                return (
                  <ToolCall
                    key={message.id}
                    className="pl-3.5"
                    name={message.name}
                    args={toolSummary(message.name, message.args)}
                    status={message.done ? "done" : "running"}
                  />
                );
              }
              if (message.kind === "command") {
                return (
                  <div key={message.id} className="pl-3.5">
                    <CommandMessage command={message.command} args={message.args || undefined} />
                  </div>
                );
              }
              if (message.kind === "result") {
                return (
                  <div key={message.id} className="pl-3.5">
                    <CommandResult command={message.command} text={message.text} ok={message.ok} />
                  </div>
                );
              }

              const thinking =
                message.kind === "assistant" && showThinkingOn && message.thinking
                  ? message.thinking
                  : null;

              const overflowNote =
                message.kind === "assistant" && message.overflow ? (
                  <div className="text-label text-smui-orange">
                    ⚠ context overflow — {message.overflow}
                  </div>
                ) : null;

              const errorNote =
                message.kind === "assistant" && message.error ? (
                  <div className="text-label text-smui-red">
                    ⚠{" "}
                    {isOverflowError(message.error)
                      ? `context overflow — ${message.error}`
                      : message.error}
                  </div>
                ) : null;

              const cancelledNote =
                message.kind === "assistant" && message.cancelled ? (
                  <div className="text-label text-muted-foreground">⊘ cancelled</div>
                ) : null;

              if (message.kind === "assistant" && !message.text && !message.done) {
                return (
                  <div key={message.id} className="flex flex-col gap-3 pl-3.5">
                    {thinking ? (
                      <ThinkingMessage content={thinking} />
                    ) : (
                      <WorkingIndicator
                        label={message.warm ? "thinking" : `loading ${message.model}`}
                      />
                    )}
                    {overflowNote}
                    {errorNote}
                  </div>
                );
              }

              // Meta (model · context · speed) rides on the final segment - the one that
              // carries usage - so it isn't repeated under every pre-tool segment.
              let metaItems: string[] | null = null;
              if (message.kind === "assistant" && message.usage) {
                const usage = message.usage;
                metaItems = [
                  message.model,
                  `${fmtTokens(usage.input)}/${fmtCtx(usage.contextWindow)} ctx`,
                ];
                if (usage.genMs > 0) {
                  metaItems.push(`${Math.round(usage.output / (usage.genMs / 1000))} tok/s`);
                }
              }

              // User prompts read as a boxed, left-barred block; assistant replies are
              // plain prose. Neither carries a "you"/"assistant" header.
              if (message.kind === "user") {
                return (
                  <div
                    key={message.id}
                    className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2"
                  >
                    {message.text ? <Md text={message.text} /> : null}
                    {message.artifacts.length ? (
                      <div className="flex flex-wrap gap-2">
                        {message.artifacts.map((ref) => (
                          <ArtifactThumb key={ref.hash} artifact={ref} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              }

              return (
                <div key={message.id} className="flex flex-col gap-3 pl-3.5">
                  {thinking ? <ThinkingMessage content={thinking} /> : null}
                  {message.text ? <Md text={message.text} /> : null}
                  {overflowNote}
                  {errorNote}
                  {cancelledNote}
                  {metaItems ? <MessageMeta items={metaItems} /> : null}
                </div>
              );
            })}

            {awaitingResponse ? (
              <div className="pl-3.5">
                <WorkingIndicator label="thinking" />
              </div>
            ) : null}

            {/* Prompts held in the local queue: shown muted as "queued" so they read as
            waiting, not sent, until the current turn frees up and they publish. */}
            {queue.map((q) => (
              <div
                key={q.id}
                className="flex flex-col gap-2 border-l-2 border-primary/50 bg-card px-3 py-2 opacity-60"
              >
                {q.text ? <Md text={q.text} muted /> : null}
                {q.artifacts?.length ? (
                  <div className="flex gap-1.5">
                    {q.artifacts.map((ref) => (
                      <ArtifactThumb key={ref.hash} artifact={ref} size={32} square />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Live task checklist, above the composer. */}
      <TasksPanel tasks={tasks} />

      {/* Pinned bottom: composer, then a two-column footer (status + model controls).
          Files dropped anywhere here upload as attachments. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: passive drop target; the
          keyboard-accessible path is the attach button below. */}
      <div
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        className="shrink-0 pt-2 pb-4"
      >
        {/* Slash menu: filters the host's announced command inventory as you type a
            leading "/". Arrows/Tab/Enter pick a row (handled on the input); a row click
            fills the composer. onMouseDown (not onClick) so the input keeps focus. */}
        {menuOpen ? (
          <div className="mb-2 overflow-hidden border border-border bg-popover">
            {menuMatches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptCommand(c.name);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left",
                  i === menuIdx ? "bg-accent" : "hover:bg-secondary",
                )}
              >
                <code className="text-sm font-semibold text-primary">{c.usage ?? c.name}</code>
                <span className="text-xs text-muted-foreground">{c.summary}</span>
              </button>
            ))}
          </div>
        ) : null}

        {uploadError ? (
          <div className="mb-2 flex items-center gap-2 text-label tracking-wider text-smui-red">
            <span>⚠ {uploadError}</span>
            <button
              type="button"
              onClick={() => setUploadError(null)}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              dismiss
            </button>
          </div>
        ) : null}

        {/* Pending attachments, shown as removable chips (image thumbnail or a file pill)
            above the input until the next prompt carries them. */}
        {attachments.length || uploading > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {attachments.map((ref) => (
              <span
                key={ref.hash}
                className="inline-flex items-center gap-1.5 border border-border bg-card px-1.5 py-1 text-xs"
              >
                <ArtifactThumb artifact={ref} size={28} square />
                {ref.kind === "image" ? (
                  <span className="max-w-[140px] truncate">{ref.name ?? ref.kind}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => removeAttachment(ref.hash)}
                  title="Remove"
                  className="cursor-pointer text-muted-foreground hover:text-smui-red"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {uploading > 0 ? (
              <span className="text-label tracking-wider text-muted-foreground">
                uploading {uploading}…
              </span>
            ) : null}
          </div>
        ) : null}

        <form onSubmit={onSubmit}>
          <div className="flex flex-col border border-input bg-background transition-colors focus-within:border-ring">
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onInputKeyDown}
              onPaste={onPaste}
              placeholder={`message ${modelMeta.label}… (/ for commands)`}
              disabled={!sessionId}
              className="w-full bg-transparent px-3 pt-2.5 pb-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed"
            />
            <div className="flex items-center gap-2 px-2 pb-2">
              <input ref={fileInputRef} type="file" multiple hidden onChange={onPickFiles} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => fileInputRef.current?.click()}
                disabled={!sessionId}
                aria-label="Attach files (or paste / drag-drop)"
              >
                <Plus className="size-4.5" />
              </Button>
            </div>
          </div>
          {/* Single text input: Enter submits the form implicitly (no send button). */}
        </form>

        {/* Footer under the prompt input: cwd/session/host (left), model controls (right). */}
        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex flex-col gap-1">
            {replayed ? (
              <div className="flex flex-col gap-1 fade-in animate-in duration-150">
                {host.workspace ? (
                  <p className="text-label tracking-wider text-muted-foreground">
                    workspace <code className="text-foreground">{host.workspace}</code>
                    {host.cwd && host.cwd !== host.workspace ? (
                      <>
                        {" · cwd "}
                        <code className="text-foreground">{host.cwd}</code>
                      </>
                    ) : null}
                  </p>
                ) : null}
                <p className="text-label tracking-wider text-muted-foreground">
                  session <code className="text-foreground">{target}</code> · {status}
                  {replayed ? " · replayed" : ""} · {events.length} events
                </p>
                {sessionId ? (
                  <p className="text-label tracking-wider">
                    {host.leaderId ? (
                      <span className="text-smui-green">
                        ● host active
                        {host.standbyCount > 0
                          ? ` (${host.leaderId.slice(0, 8)}) · ${host.standbyCount} standby`
                          : ""}
                      </span>
                    ) : host.present ? (
                      <span className="text-smui-yellow">● host starting…</span>
                    ) : (
                      <span className="text-smui-yellow">
                        ● no host on this session — start one:{" "}
                        <code className="text-foreground">{hostCommand}</code>
                      </span>
                    )}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <ModelSelector.Root
              models={modelOptions}
              value={activeProvider}
              onValueChange={setProvider}
            >
              <ModelSelector.Trigger className="w-44 text-label" />
              <ModelSelector.Content>
                <ModelSelector.Search />
                <ModelSelector.List />
              </ModelSelector.Content>
            </ModelSelector.Root>

            {modelMeta.reasoningLevels.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="text-label tracking-wider uppercase text-muted-foreground">
                  reasoning
                </span>
                <ToggleGroup
                  type="single"
                  value={reasoning}
                  onValueChange={(next) => {
                    if (next) {
                      setReasoning(next);
                    }
                  }}
                  variant="outline"
                  size="sm"
                >
                  {modelMeta.reasoningLevels.map((level) => (
                    <ToggleGroupItem
                      key={level}
                      value={level}
                      className="h-6 px-2 text-label lowercase data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                    >
                      {level}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ) : null}

            <div className="flex items-center gap-1.5">
              <Checkbox
                id="show-thinking"
                checked={showThinkingOn}
                onCheckedChange={(checked) => setShowThinking(checked === true)}
              />
              <Label
                htmlFor="show-thinking"
                className="cursor-pointer text-label tracking-wider uppercase text-muted-foreground"
              >
                show thinking
              </Label>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
