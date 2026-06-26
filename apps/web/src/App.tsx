import { useQuery } from "@tanstack/react-query";
import { type ArtifactRef, DEFAULT_SESSION_ID } from "@trevor/session";
import { useInterval, useLocalStorageState } from "ahooks";
import { ChevronDown, CircleX, PanelRight, Plus, RotateCw, TriangleAlert, X } from "lucide-react";
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
import { buildQuotedComposerText } from "@/components/assistant-ui/quote";
import { QuoteSelectionToolbar } from "@/components/assistant-ui/quote-selection-toolbar";
import { CommandMenu } from "@/components/chat/command-menu";
import { CompactingBar } from "@/components/chat/compacting-bar";
import { type ConcurrentTool, ConcurrentTools } from "@/components/chat/concurrent-tools";
import {
  CommandResult,
  MessageMeta,
  ThinkingMessage,
  type ToolStatus,
  WorkingIndicator,
} from "@/components/chat/message";
import { parseToolArgs, ToolMessage } from "@/components/chat/tool-message";
import { SidePanel } from "@/components/panel/SidePanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  defaultProviderFrom,
  fmtCtx,
  fmtTokens,
  hostStatus,
  isOverflowError,
  parseCommand,
  providerModelsFrom,
  tasksFrom,
  toolSummary,
} from "./derive";
import { useSendQueue } from "./hooks/use-send-queue";
import { Markdown } from "./markdown";
import { ensureSession, useSession, useSessionActions } from "./session/use-session";
import { TasksPanel } from "./TasksPanel";
import {
  panelModel,
  readOnlyToolBatches,
  type ToolMessage as ToolMessageData,
  toTranscript,
} from "./transcript";

const PROVIDER_KEY = "trevor.provider";
// Per-provider chosen reasoning level, and whether to render thinking text at all.
const REASONING_KEY = "trevor.reasoning";
const SHOW_THINKING_KEY = "trevor.showThinking";
// Host and browser default to one shared session so they auto-attach with no manual
// wiring; override with ?session=<id> in the URL. The id is owned in @trevor/session so
// this and the host's SESSION_ID default cannot drift into two different sessions.
const DEFAULT_SESSION = DEFAULT_SESSION_ID;
// The local send queue + hard-steer fold (QueuedPrompt, sendQueueReducer, foldSteer)
// live in ./send-queue, unit-tested without React; the React state machine that drives
// them (the busy/in-flight latch + release/drain effects) lives in ./hooks/use-send-queue.
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

  // No default here: an unset provider falls through to the host-announced default
  // (defaultProviderFrom) below, so the initial selection is host-owned, not hardcoded.
  const [provider, setProvider] = useLocalStorageState<string>(PROVIDER_KEY, rawString);
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

  const { events, status, replayed, presence } = useSession(sessionId);
  const { publish, cancel, command, openInEditor } = useSessionActions(sessionId);
  // These scan the whole event log; without memoizing, every keystroke in the draft
  // input (and the 4s clock tick) would rebuild them. host depends on now; the others
  // only on events, so they skip the tick.
  const transcript = useMemo(() => toTranscript(events), [events]);
  // Runs of 2+ consecutive read-only tool rows were one concurrent batch (D-050); group them so
  // they render as a single compact block instead of stacked cards.
  const toolBatches = useMemo(() => readOnlyToolBatches(transcript), [transcript]);
  // Maps one batched read-only tool message to a ConcurrentTools row: status from done + an
  // `error:` result, args via the shared summary, and a clickable path for path-bearing tools.
  const toConcurrentTool = (tool: ToolMessageData): ConcurrentTool => {
    const status: ToolStatus = !tool.done
      ? "running"
      : tool.result?.startsWith("error:")
        ? "error"
        : "done";
    const path = parseToolArgs(tool.args).path;
    return {
      id: tool.id,
      name: tool.name,
      args: toolSummary(tool.name, tool.args),
      status,
      onOpenPath: typeof path === "string" && path ? () => void openInEditor(path) : undefined,
    };
  };
  const awaitingResponse = transcript.at(-1)?.kind === "user";
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 4000);
  const host = useMemo(() => hostStatus(events, presence, now), [events, presence, now]);
  const hostModels = useMemo(() => providerModelsFrom(events), [events]);
  // The host-announced default provider; the initial selection falls back to it when the
  // user hasn't chosen one, rather than to a hardcoded key.
  const hostDefault = useMemo(() => defaultProviderFrom(events), [events]);
  const active = useMemo(() => activeRunId(events), [events]);
  // True while a manual /compact fold is streaming (a transient bar in the transcript). ESC cancels
  // it (manual folds are interruptible; automatic ones run to completion).
  const compacting = useMemo(() => transcript.some((m) => m.kind === "compacting"), [transcript]);

  // The agent's live task checklist (host-published snapshots), rendered in the header.
  const tasks = useMemo(() => tasksFrom(events), [events]);

  // The SidePanel's whole view-model in one pure selector: live-vs-completed precedence
  // for the Request data (ctx meter + treemap) and the per-category context aggregation,
  // folded from the transcript (+ raw events for the live snapshot). Spread into
  // <SidePanel> below. host depends on `now`; this only on transcript/events.
  const panel = useMemo(
    () => panelModel(transcript, events, { replayed }),
    [transcript, events, replayed],
  );
  // The right-side panel is toggleable; remember the choice across reloads.
  const [panelOpen, setPanelOpen] = useLocalStorageState<boolean>("trevor.panel", {
    defaultValue: true,
  });

  // Immediate host commands the host announced, plus the set of names used to tell a
  // command from an ordinary prompt at submit time.
  const commands = useMemo(() => commandsFrom(events), [events]);
  const commandNames = useMemo(() => new Set(commands.map((c) => c.name)), [commands]);
  // Slash menu: open while the draft is a bare "/token" (no space yet) with matches,
  // unless Esc dismissed it for exactly this text. menuIndex is the highlighted row.
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
  // The reducer wiring + the in-flight/echo latch + the release/drain effects live in
  // useSendQueue; App.tsx calls submit/steer and renders the queue.
  const busy = active !== null || awaitingResponse;
  const { queue, submit, steer } = useSendQueue({ busy, publish });

  const activeProvider = provider ?? hostDefault ?? "qwen";
  // Before any host has announced (empty hostModels), there's no roster to show: fall back
  // to a neutral descriptor keyed by the active provider, so the picker renders one inert
  // entry and no reasoning control until host.online arrives and supplies the real roster.
  const modelMeta = hostModels[activeProvider] ?? {
    label: activeProvider,
    model: activeProvider,
    reasoningLevels: [],
    defaultReasoning: "off",
    kind: "local" as const,
  };
  // Model options for the picker, grouped local-first then cloud (the picker renders a
  // labeled section per group). Falls back to the active model before the host announces.
  const modelOptions =
    Object.keys(hostModels).length > 0
      ? Object.entries(hostModels)
          .map(([id, meta]) => ({
            id,
            name: meta.label,
            group: meta.kind === "local" ? "Local" : "Cloud",
          }))
          .sort((a, b) => (a.group === b.group ? 0 : a.group === "Local" ? -1 : 1))
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
      setAtBottom(true); // re-pin: follow the command + its result down to the bottom
      return;
    }
    if (!text && attachments.length === 0) {
      return;
    }
    setDraft("");
    const artifacts = attachments.length ? attachments : undefined;
    setAttachments([]);
    submit({
      id: crypto.randomUUID(),
      text,
      provider: activeProvider,
      reasoning: reasoning || undefined,
      artifacts,
    });
    // Re-pin to the bottom on submit, even if scrolled up: the follow effect then snaps to each
    // new item (the prompt when its event round-trips, then the streaming answer) and holds there.
    setAtBottom(true);
  };

  // Slash-menu key handling on the composer, active only while the menu is open:
  // arrows move the highlight, Tab/Enter complete it, Esc dismisses (and is swallowed
  // so the window ESC cancel/steer handler doesn't also fire). An exact match + Enter
  // falls through to submit, so a fully-typed command runs on one Enter.
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const selected = menuOpen ? menuMatches[menuIdx] : undefined;
    if (!selected) {
      // Menu closed: in a textarea Enter inserts a newline, so submit explicitly. Enter
      // sends; Shift+Enter keeps the newline (for multi-line prompts and quoted blocks).
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
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
    } else if (event.key === "Enter" && !event.shiftKey) {
      // Complete the highlighted command, or submit when it is already fully typed.
      event.preventDefault();
      if (selected.name !== draft) {
        acceptCommand(selected.name);
      } else {
        event.currentTarget.form?.requestSubmit();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuDismissedFor(draft);
    }
  };

  // Hard steer: abort the active turn and fold queued prompts + draft into ONE
  // steering prompt that runs next. The single steer replaces the queue, so the
  // cancelled turn is followed by one combined interruption (not a replay of the
  // queue). It publishes only once the cancel resolves the turn (busy -> idle),
  // keeping the cancel strictly ahead of the steer.
  const onCancel = () => {
    const runId = active ?? (awaitingResponse ? "" : null);
    // Fold the queued prompts + draft + queued/attached artifacts into ONE steering
    // prompt that replaces the queue, then ask the host to cancel the active run.
    steer(draft, attachments, {
      id: crypto.randomUUID(),
      provider: activeProvider,
      reasoning: reasoning || undefined,
    });
    setDraft("");
    setAttachments([]);
    if (runId !== null) {
      void cancel(runId);
    } else if (compacting) {
      // No turn to cancel, but a manual /compact is folding - ESC aborts it (empty runId).
      void cancel("");
    }
    // Return focus to the composer so the user can type the next prompt immediately after cancelling.
    inputRef.current?.focus();
  };

  // ESC mirrors the cancel button when a run is active/pending; with nothing to
  // cancel it just clears the composer. One window listener reads the latest state
  // from a ref so it never goes stale and works regardless of which element has focus.
  const escRef = useRef({
    active,
    awaiting: awaitingResponse,
    compacting,
    draft,
    setDraft,
    onCancel,
  });
  escRef.current = { active, awaiting: awaitingResponse, compacting, draft, setDraft, onCancel };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const s = escRef.current;
      const runId = s.active ?? (s.awaiting ? "" : null);
      // A turn to cancel, OR a manual fold to abort - either routes through onCancel.
      if (runId !== null || s.compacting) {
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

  // The transcript container is flex-col-reverse, so it sits at the bottom (newest) from
  // the first paint and natively stays pinned when new items arrive WHILE at the bottom -
  // and leaves the view alone when scrolled up (no yank). All we add is a jump-to-bottom
  // affordance: track whether we're at the bottom (col-reverse => scrollTop 0 is the
  // bottom, so |scrollTop| within a few px counts as "at bottom"), and show a down-chevron
  // when not. The chevron scrolls back to 0 (the bottom) and then vanishes.
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const onTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (el) {
      setAtBottom(Math.abs(el.scrollTop) < 40);
    }
  };
  const scrollToBottom = () => transcriptRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  // Follow the bottom while pinned: when `atBottom`, snap to the newest content on EVERY transcript
  // update - a streaming answer, a burst of tool rows, or the two events a /compact appends (the
  // command then its result) all keep the view at the bottom, not just the first one. Instant (no
  // smooth) so it tracks tightly without lagging behind a fast stream; col-reverse alone did not
  // hold through multi-event bursts. Scrolling up flips `atBottom` off (onTranscriptScroll) and
  // stops the follow; a submit re-arms it via setAtBottom(true). A no-op when already at 0.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `transcript` is the trigger (not read) - re-pin on each update while at the bottom.
  useEffect(() => {
    if (atBottom) {
      transcriptRef.current?.scrollTo({ top: 0 });
    }
  }, [transcript, atBottom]);

  // Auto-grow the composer to fit multi-line prompts and quoted blocks, capped by its
  // max-height (then it scrolls). Reset to "auto" first so it also shrinks back down. `draft`
  // is the dependency on purpose: it drives the textarea content whose height we re-measure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the draft changes
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Quote a highlighted message into the composer: append it as a markdown blockquote
  // below the current draft, then focus the input and park the cursor on the fresh line
  // beneath it (GitHub-style). Driven by QuoteSelectionToolbar's selection detection.
  const quoteSelection = (selected: string) => {
    const { value, cursor } = buildQuotedComposerText(draft, selected);
    setDraft(value);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.setSelectionRange(cursor, cursor);
      }
    });
  };

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
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
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

  // Model + reasoning + thinking controls, moved out of the footer into the panel.
  const panelControls = (
    <>
      <ModelSelector.Root models={modelOptions} value={activeProvider} onValueChange={setProvider}>
        <ModelSelector.Trigger className="w-full justify-between text-label" />
        <ModelSelector.Content>
          <ModelSelector.Search />
          <ModelSelector.List />
        </ModelSelector.Content>
      </ModelSelector.Root>

      {modelMeta.reasoningLevels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
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
            className="shrink-0"
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
    </>
  );

  // Host/connection status, moved out of the footer into the panel header.
  const statusNode =
    replayed && sessionId ? (
      host.leaderId ? (
        <span className="text-smui-green">
          ● host active
          {host.standbyCount > 0 ? ` · ${host.standbyCount} standby` : ""}
        </span>
      ) : host.present ? (
        <span className="text-smui-yellow">● host starting…</span>
      ) : (
        <span className="text-smui-yellow">
          ● no host — <code className="text-foreground">{hostCommand}</code>
        </span>
      )
    ) : null;

  return (
    <div className="flex h-svh">
      <main className="relative flex min-w-0 flex-1 flex-col bg-smui-surface-sunken px-4">
        {/* Highlight text in any message (data-message-id) to get a floating Quote action
          that drops the selection into the composer as a markdown blockquote. */}
        <QuoteSelectionToolbar onQuote={quoteSelection} />
        {!panelOpen ? (
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            aria-label="Open panel"
            className="absolute top-4 right-4 z-10 cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <PanelRight className="size-4.5" />
          </button>
        ) : null}
        {/* Transcript fills the view; the composer + footer pin to the bottom.
          Scrollbar is hidden but the region still scrolls. The relative wrapper anchors
          the jump-to-bottom chevron over the transcript's lower edge. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={transcriptRef}
            onScroll={onTranscriptScroll}
            className="flex flex-1 flex-col-reverse overflow-y-auto py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {/* Nothing renders until the full history has replayed, then it appears all at
            once (already pinned to the bottom) with a 150ms fade-in. */}
            {replayed ? (
              <div className="flex flex-col gap-8 fade-in animate-in duration-150">
                {transcript.map((message, index) => {
                  // Consecutive tool calls read as one block: collapse the gap-8 between
                  // a tool row and the tool row directly above it.
                  const toolClass = cn(
                    "pl-3.5",
                    message.kind === "tool" && transcript[index - 1]?.kind === "tool" && "-mt-6",
                  );
                  // Every tool message dispatches to its renderer in one place: ToolMessage
                  // owns the name ladder, the done -> status derivation, and the per-tool
                  // arg/result parsing.
                  if (message.kind === "tool") {
                    // A continuation row of a concurrent batch already drawn at its first row.
                    if (toolBatches.skip.has(message.id)) {
                      return null;
                    }
                    const batch = toolBatches.batchAt.get(message.id);
                    if (batch) {
                      return (
                        <div key={message.id} className={toolClass}>
                          <ConcurrentTools tools={batch.map(toConcurrentTool)} />
                        </div>
                      );
                    }
                    return (
                      <ToolMessage
                        key={message.id}
                        message={message}
                        className={toolClass}
                        onOpenPath={(path) => void openInEditor(path)}
                      />
                    );
                  }
                  if (message.kind === "result") {
                    return (
                      <div key={message.id} className="pl-3.5">
                        <CommandResult
                          command={message.command}
                          text={message.text}
                          ok={message.ok}
                        />
                      </div>
                    );
                  }
                  if (message.kind === "recovered") {
                    const reclaimed =
                      message.reclaimed > 0
                        ? ` · ~${fmtTokens(Math.round(message.reclaimed / 4))} reclaimed`
                        : "";
                    return (
                      <div key={message.id} className="pl-3.5">
                        <Alert className="border-smui-yellow/25 bg-smui-yellow/[0.04] [&>svg]:text-smui-yellow">
                          <RotateCw className="h-3.5 w-3.5" />
                          <AlertTitle className="text-smui-yellow">context full</AlertTitle>
                          <AlertDescription>
                            {message.detail}
                            {reclaimed} · retrying
                          </AlertDescription>
                        </Alert>
                      </div>
                    );
                  }
                  if (message.kind === "reconnecting") {
                    // A transient provider outage being auto-retried before any token streamed
                    // (D-079). Frost styling distinguishes a transport reconnect from the yellow
                    // "context full" airbag; the cap (3) mirrors the host's MAX_RECONNECT_ATTEMPTS.
                    return (
                      <div key={message.id} className="pl-3.5">
                        <Alert className="border-smui-blue/25 bg-smui-blue/[0.04] [&>svg]:text-smui-blue">
                          <RotateCw className="h-3.5 w-3.5" />
                          <AlertTitle className="text-smui-blue">connection dropped</AlertTitle>
                          <AlertDescription>
                            {message.detail} · reconnecting (attempt {message.attempt}/3)
                          </AlertDescription>
                        </Alert>
                      </div>
                    );
                  }
                  if (message.kind === "compacting") {
                    // The live cross-turn fold (D-040): a TRANSIENT bar that vanishes when the fold
                    // completes. Its own component owns the continuous (rAF) fill animation.
                    return (
                      <CompactingBar
                        key={message.id}
                        tokens={message.tokens}
                        budget={message.budget}
                      />
                    );
                  }
                  if (message.kind === "delegation") {
                    // A subagent delegation (D-046..D-048): a distinct linked block - which agent ran
                    // in its own isolated child session, the task, and the distilled result once it
                    // folds back. Purple (vs the tool-card greys) marks it as a sub-run, not a tool. A
                    // background child is async (read-only, result arrives later), so it reads distinctly.
                    const running = message.status === "running";
                    const failed = message.status === "failed";
                    const isBackground = message.mode === "background";
                    const tone = failed
                      ? "text-smui-red"
                      : running
                        ? "text-smui-purple"
                        : "text-smui-green";
                    const verb = running
                      ? isBackground
                        ? "running in background…"
                        : "delegating…"
                      : failed
                        ? "delegation failed"
                        : "delegated";
                    return (
                      <div key={message.id} className="pl-3.5">
                        <Alert className="border-smui-purple/25 bg-smui-purple/[0.04] [&>svg]:text-smui-purple">
                          <PanelRight className="h-3.5 w-3.5" />
                          <AlertTitle className={tone}>
                            {message.agent} · {verb}
                          </AlertTitle>
                          <AlertDescription>
                            <div className="text-muted-foreground">{message.task}</div>
                            {message.result ? (
                              <div className="mt-1 whitespace-pre-wrap">{message.result}</div>
                            ) : null}
                          </AlertDescription>
                        </Alert>
                      </div>
                    );
                  }

                  const thinking =
                    message.kind === "assistant" && showThinkingOn && message.thinking
                      ? message.thinking
                      : null;

                  const overflowNote =
                    message.kind === "assistant" && message.overflow ? (
                      <Alert className="border-smui-yellow/25 bg-smui-yellow/[0.04] [&>svg]:text-smui-yellow">
                        <TriangleAlert className="h-3.5 w-3.5" />
                        <AlertTitle className="text-smui-yellow">context overflow</AlertTitle>
                        <AlertDescription>{message.overflow}</AlertDescription>
                      </Alert>
                    ) : null;

                  const errorNote =
                    message.kind === "assistant" && message.error ? (
                      <Alert variant="destructive">
                        <CircleX className="h-3.5 w-3.5" />
                        <AlertTitle>
                          {isOverflowError(message.error) ? "context overflow" : "error"}
                        </AlertTitle>
                        <AlertDescription>{message.error}</AlertDescription>
                      </Alert>
                    ) : null;

                  const cancelledNote =
                    message.kind === "assistant" && message.cancelled ? (
                      <div className="text-sm text-smui-red">cancelled</div>
                    ) : null;

                  // The host closed this turn (a restart/crash reaped it mid-flight), not the user.
                  const interruptedNote =
                    message.kind === "assistant" && message.interrupted ? (
                      <div className="text-sm text-smui-red">interrupted · host restarted</div>
                    ) : null;

                  const noReplyNote =
                    message.kind === "assistant" && message.noReply ? (
                      <Alert className="border-smui-yellow/25 bg-smui-yellow/[0.04] [&>svg]:text-smui-yellow">
                        <TriangleAlert className="h-3.5 w-3.5" />
                        <AlertTitle className="text-smui-yellow">no reply</AlertTitle>
                        <AlertDescription>
                          The model ended the turn without a reply. Try again or rephrase.
                        </AlertDescription>
                      </Alert>
                    ) : null;

                  // Budget-terminated turn: the answer above was forced after the model hit
                  // its tool-call budget (step backstop or context pressure). A muted footnote
                  // so the answer reads normally but the user knows it was cut short of more work.
                  const stepLimitNote =
                    message.kind === "assistant" && message.stepLimit ? (
                      <div className="text-label text-muted-foreground">
                        ⚐ answered after the {message.stepLimit}-step tool budget
                      </div>
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
                        data-message-id={message.id}
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
                    <div
                      key={message.id}
                      data-message-id={message.id}
                      className="flex flex-col gap-3 pl-3.5"
                    >
                      {thinking ? <ThinkingMessage content={thinking} /> : null}
                      {message.text ? <Md text={message.text} /> : null}
                      {overflowNote}
                      {errorNote}
                      {cancelledNote}
                      {interruptedNote}
                      {noReplyNote}
                      {stepLimitNote}
                      {metaItems ? <MessageMeta items={metaItems} /> : null}
                    </div>
                  );
                })}

                {/* A persistent "working" pulse whenever a turn is in flight - not just while
                    waiting for the first token. Fills the dead air between steps (e.g. while the
                    model generates the next thinking/tool batch after a read completes), so the
                    turn never looks stalled. `active` is the running run id (null once it ends). */}
                {active !== null || awaitingResponse ? (
                  <div className="pl-3.5">
                    <WorkingIndicator label="working" />
                  </div>
                ) : null}

                {/* Prompts held in the local queue: rendered as subdued "> …" blockquote lines (not
            transcript chrome) so they read as waiting, not sent, until the turn frees up and they
            publish. Several stack as one quote block; an attached image rides under its line. */}
                {queue.length ? (
                  <div className="flex flex-col gap-1 pl-3.5 opacity-70">
                    {queue.map((q) => (
                      <div key={q.id} className="flex items-start gap-2 text-muted-foreground">
                        <span aria-hidden className="shrink-0 select-none">
                          &gt;
                        </span>
                        <div className="flex min-w-0 flex-col gap-1">
                          {q.text ? <Md text={q.text} muted /> : null}
                          {q.artifacts?.length ? (
                            <div className="flex gap-1.5">
                              {q.artifacts.map((ref) => (
                                <ArtifactThumb key={ref.hash} artifact={ref} size={32} square />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {!atBottom ? (
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label="Scroll to bottom"
              className="absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground"
            >
              <ChevronDown className="size-4" />
            </button>
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
          className="relative shrink-0 pt-2 pb-4"
        >
          {/* Slash menu: overlays above the composer (absolute, so it never pushes the
            transcript up). Filters the host's announced command inventory as you type a
            leading "/", with the matched prefix highlighted. Arrows/Tab/Enter pick a row
            (handled on the input); a row click fills the composer. onMouseDown (not
            onClick) so the input keeps focus. */}
          {menuOpen ? (
            <CommandMenu
              className="absolute inset-x-0 bottom-full z-20 mb-2"
              matches={menuMatches}
              activeIndex={menuIdx}
              query={slashQuery ?? ""}
              onPick={acceptCommand}
            />
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
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onInputKeyDown}
                onPaste={onPaste}
                placeholder={`message ${modelMeta.label}… (/ for commands)`}
                disabled={!sessionId}
                rows={1}
                className="max-h-48 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed"
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
            {/* Auto-growing textarea: Enter submits, Shift+Enter inserts a newline. */}
          </form>
        </div>
      </main>

      {panelOpen ? (
        <SidePanel
          title={target}
          subtitle={`${status}${replayed ? " · replayed" : ""} · ${events.length} events`}
          statusNode={statusNode}
          workspace={host.workspace ?? undefined}
          {...panel}
          ready={replayed}
          controls={panelControls}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}

      {/* Pinned bottom-right: the session id, for orientation across tabs. */}
      <div className="fixed right-3 bottom-2 z-[100] flex items-center gap-1.5">
        <div className="rounded border border-border bg-card/90 px-2 py-1 font-mono text-label tracking-wider text-muted-foreground shadow-sm backdrop-blur-sm">
          {target}
        </div>
      </div>
    </div>
  );
}
