import { useQuery } from "@tanstack/react-query";
import {
  activeTurnRunId,
  constrainReasoning,
  DEFAULT_SESSION_ID,
  type ModelRef,
  modelRefFromProvider,
} from "@trevor/session";
import { useInterval, useLocalStorageState } from "ahooks";
import { ArrowLeft, GitBranch, History } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type SubmitEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConcurrentTool } from "@/components/chat/concurrent-tools";
import type { ToolStatus } from "@/components/chat/message";
import { parseToolArgs } from "@/components/chat/tool-message";
import { ModelChooser } from "@/components/chooser/model-chooser";
import { PanelHost } from "@/components/panel/PanelHost";
import { ControlsPanel } from "@/components/panel/panel-controls";
import { useModelSelection } from "@/hooks/use-model-selection";
import { caretOnFirstLine, caretOnLastLine } from "./composer-caret";
import {
  activeTurnStartedAt,
  catalogFrom,
  commandsFrom,
  defaultProviderFrom,
  hostStatus,
  isSessionArchived,
  latestSessionSwitch,
  parseBangShell,
  parseCommand,
  pendingQuestionFrom,
  providerModelsFrom,
  sourceSignInFrom,
  sourcesFrom,
  tasksFrom,
  toolSummary,
} from "./derive";
import { escapeAction } from "./esc-action";
import { useComposer } from "./hooks/use-composer";
import { useDraftPersistence } from "./hooks/use-draft-persistence";
import { useModalState } from "./hooks/use-modal-state";
import { usePromptHistory } from "./hooks/use-prompt-history";
import { useScrollFollow } from "./hooks/use-scroll-follow";
import { useSendQueue } from "./hooks/use-send-queue";
import { useSlashMenu } from "./hooks/use-slash-menu";
import {
  archiveSession,
  deleteSession,
  ensureSession,
  renameSession,
  useSession,
  useSessionActions,
  webTabId,
} from "./session/use-session";
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
const BUILT_IN_COMMANDS = [
  { name: "/clear", summary: "Start a fresh session" },
  { name: "/cd", summary: "Switch directories in a fresh session", usage: "/cd <directory>" },
  { name: "/resume", summary: "Open a prior session (no implicit resume)" },
  { name: "/worktree", summary: "Switch a Trevor-managed worktree" },
] as const;

function targetFromLocation(): string {
  return new URLSearchParams(window.location.search).get("session") ?? DEFAULT_SESSION;
}

function urlForSession(sessionId: string): URL {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  return url;
}

// The local send queue + hard-steer fold (QueuedPrompt, sendQueueReducer, foldSteer)
// live in ./send-queue, unit-tested without React; the React state machine that drives
// them (the busy/in-flight latch + release/drain effects) lives in ./hooks/use-send-queue.
const rawString = { serializer: (value: string) => value, deserializer: (value: string) => value };

export function App() {
  const [target, setTarget] = useState(() => targetFromLocation());
  const navigateToSession = useCallback(
    (sessionId: string) => {
      if (sessionId === target) {
        return;
      }
      window.history.pushState(null, "", urlForSession(sessionId));
      setTarget(sessionId);
    },
    [target],
  );

  useEffect(() => {
    const syncTarget = () => setTarget(targetFromLocation());
    window.addEventListener("popstate", syncTarget);
    return () => window.removeEventListener("popstate", syncTarget);
  }, []);

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
  // The composer's local state as one boundary: draft, pending attachments + upload state, refs, and
  // the file-intake handlers. App keeps the submit/steer/slash-menu wiring (send queue + commands)
  // and passes the whole `composer` object to PanelHost; it also reads a few fields here for that
  // wiring (the submit path clears the draft/attachments, the slash menu refocuses the input, etc.).
  const composer = useComposer();
  const { draft, setDraft, imageRefs, attachments, setAttachments, inputRef } = composer;

  const stream = useSession(sessionId);
  const { events, presence, replayed, replayThroughSeq, status } = stream;
  const {
    publish,
    cancel,
    command,
    shell,
    openInEditor,
    refreshCatalog,
    signInSource,
    submitSignInCode,
    unarchive,
    answerQuestion,
  } = useSessionActions(sessionId);

  // Tab-local composer recovery + history (D-083/D-084), keyed by this tab's id + the session id and
  // kept in sessionStorage (tab-scoped, survives a reload). Draft persistence restores an unsubmitted
  // draft; prompt history records published prompts + bang commands for ArrowUp/ArrowDown recall.
  const tabId = useMemo(() => webTabId(), []);
  useDraftPersistence({ storage: window.sessionStorage, tabId, sessionId, draft, setDraft });
  const history = usePromptHistory({ storage: window.sessionStorage, tabId, sessionId });
  // These scan the whole event log; without memoizing, every keystroke in the draft
  // input (and the 4s clock tick) would rebuild them. host depends on now; the others
  // only on events, so they skip the tick.
  const transcript = useMemo(() => toTranscript(events), [events]);
  const switchTarget = useMemo(
    () =>
      replayThroughSeq === null
        ? null
        : latestSessionSwitch(events, { afterSeq: replayThroughSeq }),
    [events, replayThroughSeq],
  );
  useEffect(() => {
    if (switchTarget && switchTarget !== target) {
      navigateToSession(switchTarget);
    }
  }, [navigateToSession, switchTarget, target]);
  // Runs of 2+ consecutive read-only tool rows were one concurrent batch (D-050); group them so
  // they render as a single compact block instead of stacked cards.
  const toolBatches = useMemo(() => readOnlyToolBatches(transcript), [transcript]);
  const scroll = useScrollFollow(transcript.length);
  // Maps one batched read-only tool message to a ConcurrentTools row: status from done + an
  // `error:` result, args via the shared summary, and a clickable path for path-bearing tools.
  const toConcurrentTool = (tool: ToolMessageData): ConcurrentTool => {
    // An aborted tool (run cancelled before it completed) is an error state, not "running" or a
    // successful "done" - so a parallel read-only batch stops counting it as in-flight after ESC.
    const status: ToolStatus = tool.aborted
      ? "error"
      : !tool.done
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
  // Reflect WHERE we are in the tab/window title (not a bare "Trevor"): the project name - the
  // host-announced workspace basename when known, else the session-id slug (the `<name>-<hash>` the
  // launcher mints, hash stripped). The default shared session stays plain "Trevor".
  useEffect(() => {
    const fromWorkspace = host.workspace?.split("/").filter(Boolean).pop();
    const fromSession =
      target === DEFAULT_SESSION ? null : target.replace(/-[0-9a-f]{8}$/, "") || target;
    const label = (fromWorkspace && fromWorkspace !== "~" ? fromWorkspace : null) ?? fromSession;
    document.title = label ? `${label} · Trevor` : "Trevor";
  }, [host.workspace, target]);
  const hostModels = useMemo(() => providerModelsFrom(events), [events]);
  // The host-owned model sources + catalog (D-065): the real provider/runtime/subscription list with
  // auth state and each configured source's live model catalog. Empty until the host's first catalog
  // load re-announces, so the chooser falls back to the roster projection until then.
  const hostSources = useMemo(() => sourcesFrom(events), [events]);
  const hostCatalog = useMemo(() => catalogFrom(events), [events]);
  // The in-flight source sign-in (D-065 M5): show the verification URL while the flow is active. A
  // device-code flow (Codex) carries a userCode; a browser+paste flow (Anthropic) carries acceptsCode
  // and the user pastes the returned code back.
  const signIn = useMemo(() => sourceSignInFrom(events), [events]);
  const signInDeviceCode =
    signIn?.phase === "device-code" && signIn.verificationUri
      ? {
          verificationUrl: signIn.verificationUri,
          ...(signIn.userCode ? { userCode: signIn.userCode } : {}),
          ...(signIn.acceptsCode ? { acceptsCode: true } : {}),
        }
      : null;
  // The host-announced default provider; the initial selection falls back to it when the
  // user hasn't chosen one, rather than to a hardcoded key.
  const hostDefault = useMemo(() => defaultProviderFrom(events), [events]);
  const active = useMemo(() => activeTurnRunId(events), [events]);
  const busy = active !== null || awaitingResponse;
  // Modal, drawer, inventory, and project scoping state are one App-owned view boundary shared by
  // /resume, /worktree, the left session sidebar, and the right details panel.
  const modal = useModalState({ events, host, target, sessionId, busy });
  // Whether the open session is archived (D-094): a deep link or an archive-while-open can land the
  // browser on an archived session; the main UI then gates sending behind an explicit unarchive.
  const archived = useMemo(() => isSessionArchived(events), [events]);
  // A short, friendly name for the header strip (D-093): the first user prompt, one line and capped,
  // falling back to the session id before anything has been said.
  const sessionName = useMemo(() => {
    const firstUser = transcript.find((m) => m.kind === "user");
    const text = firstUser && "text" in firstUser ? firstUser.text.trim().replace(/\s+/g, " ") : "";
    if (!text) {
      return target;
    }
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }, [transcript, target]);
  // The in-flight turn's start time (ms epoch), driving the live "Working (elapsed)" timer.
  const turnStartedAt = useMemo(() => activeTurnStartedAt(events), [events]);
  // True while a manual /compact fold is streaming (a transient bar in the transcript). ESC cancels
  // it (manual folds are interruptible; automatic ones run to completion).
  const compacting = useMemo(() => transcript.some((m) => m.kind === "compacting"), [transcript]);

  // The agent's live task checklist (host-published snapshots), rendered in the header.
  const tasks = useMemo(() => tasksFrom(events), [events]);
  // The pending ask_user question (M5): projected from the log, it takes over the composer until answered.
  const pendingQuestion = useMemo(() => pendingQuestionFrom(events), [events]);

  // The SidePanel's whole view-model in one pure selector: live-vs-completed precedence
  // for the Request data (ctx meter + treemap) and the per-category context aggregation,
  // folded from the transcript (+ raw events for the live snapshot). Spread into
  // <SidePanel> below. host depends on `now`; this only on transcript/events.
  const panel = useMemo(
    () => panelModel(transcript, events, { replayed }),
    [transcript, events, replayed],
  );
  // Immediate host commands the host announced, plus the set of names used to tell a
  // command from an ordinary prompt at submit time.
  const commands = useMemo(() => commandsFrom(events), [events]);
  const commandSpecs = useMemo(() => {
    const announced = new Set(commands.map((c) => c.name));
    return [...BUILT_IN_COMMANDS.filter((c) => !announced.has(c.name)), ...commands];
  }, [commands]);
  const commandNames = useMemo(() => new Set(commandSpecs.map((c) => c.name)), [commandSpecs]);
  const slashMenu = useSlashMenu({ draft, commandSpecs, inputRef, setDraft });
  // Focus the composer on load, once the session resolves and the input is enabled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref (from useComposer).
  useEffect(() => {
    if (sessionId) {
      inputRef.current?.focus();
    }
  }, [sessionId]);
  // Refocus the composer whenever the tab/window regains focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref (from useComposer).
  useEffect(() => {
    const focusInput = () => inputRef.current?.focus();
    window.addEventListener("focus", focusInput);
    return () => window.removeEventListener("focus", focusInput);
  }, []);
  // Vim-style "insert mode": pressing `i` while not already typing in a field focuses the composer,
  // so after clicking around the page you can jump straight back to the input. Ignored when a field
  // already has focus (so you can type the letter i) or with a modifier (so app/browser chords pass).
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref (from useComposer).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "i" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Local send queue: a prompt submitted while a turn is in flight waits here and is
  // published only once the session is idle, so the host never receives two prompts
  // at once (which would run concurrent, out-of-order turns) and the event log stays
  // cleanly paired. ESC-steer prepends, so an interruption preempts what's waiting.
  // The reducer wiring + the in-flight/echo latch + the release/drain effects live in
  // useSendQueue; App.tsx calls submit/steer and renders the queue.
  const { pending, queue, submit, steer } = useSendQueue({ busy, publish, resetKey: sessionId });
  const visibleQueue = pending ? [pending, ...queue] : queue;

  const firstAnnouncedProvider = Object.keys(hostModels)[0];
  const activeProvider = provider ?? hostDefault ?? firstAnnouncedProvider ?? "default";
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
  // Keep a stale stored level from showing as selected if the model's options changed.
  const stored = reasoningMap?.[activeProvider];
  const reasoning =
    stored && modelMeta.reasoningLevels.includes(stored) ? stored : modelMeta.defaultReasoning;
  const showThinkingOn = showThinking ?? true;
  const setReasoning = (level: string) =>
    setReasoningMap({ ...(reasoningMap ?? {}), [activeProvider]: level });
  // The active selection as a stable ModelRef (D-065 migration): the source IS the provider key, the
  // model id comes from the host roster, and reasoning is the chosen level (null = provider default).
  // Sent ALONGSIDE the legacy provider/reasoning so the host resolves through resolveUserTurnModel
  // while old clients keep working. Today each source carries one model, so this tracks the provider
  // selection and the reasoning toggle; the chooser/quick-picker just sync the provider + record recents.
  const activeModelRef = modelRefFromProvider(activeProvider, modelMeta.model, reasoning || null);

  // The model chooser (D-065 M3/M6): the persisted ModelPreferences + the source/catalog read models
  // (projected from the announced roster), the quick-picker recents, and the select transition. The
  // legacy provider/reasoning are the seed + stay in sync on a pick, so the existing sidebar behavior
  // and the send path keep working unchanged.
  const selection = useModelSelection({
    roster: hostModels,
    hostSources,
    hostCatalog,
    legacyProvider: activeProvider,
    legacyReasoning: reasoning || null,
  });
  const [chooserOpen, setChooserOpen] = useState(false);
  // A pick from the quick picker OR the full chooser: record it (recents + persisted active, reasoning
  // clamped to the model's surface), sync the legacy provider + reasoning so the rest of the UI and the
  // send path follow, and close the chooser.
  const onSelectModel = (ref: ModelRef) => {
    selection.select(ref);
    setProvider(ref.sourceId);
    const clamped = constrainReasoning(selection.reasoningSurface(ref), ref.reasoning);
    if (clamped != null) {
      setReasoningMap({ ...(reasoningMap ?? {}), [ref.sourceId]: clamped });
    }
    setChooserOpen(false);
  };
  // The active model for DISPLAY + SEND: the explicit/persisted selection (a catalog ModelRef, e.g.
  // {zai, glm-5.2}) wins; before any pick it's the legacy provider-derived ref. Routing the send
  // through this is what carries the real modelId to the host (not the legacy provider key). The label
  // keeps the legacy roster's curated name for a registered provider, else the catalog display name.
  const sendModel = selection.active ?? activeModelRef;
  const activeLabel = hostModels[activeProvider] ? modelMeta.label : selection.activeLabel;
  // The active model's reasoning surface (D-065): its catalog entry's levels for a catalog pick, else
  // the legacy roster - so the reasoning control matches the chosen model instead of vanishing, and the
  // turn carries the reasoning the model actually supports. The toggle is keyed by the active source.
  const activeEntry = (selection.catalogBySource[sendModel.sourceId] ?? []).find(
    (e) => e.modelId === sendModel.modelId,
  );
  const activeReasoningLevels =
    activeEntry && activeEntry.reasoningLevels.length > 0
      ? activeEntry.reasoningLevels
      : modelMeta.reasoningLevels;
  const storedReasoning = reasoningMap?.[activeProvider];
  const activeReasoning =
    storedReasoning && activeReasoningLevels.includes(storedReasoning)
      ? storedReasoning
      : (activeEntry?.defaultReasoning ?? modelMeta.defaultReasoning);
  // The ModelRef sent with the turn: the active model + the live reasoning (so changing the toggle
  // takes effect on the next turn even after an explicit chooser pick).
  const sendModelRef: ModelRef = {
    sourceId: sendModel.sourceId,
    modelId: sendModel.modelId,
    reasoning: activeReasoning || null,
  };

  const hostCommand =
    target === DEFAULT_SESSION
      ? "pnpm --filter @trevor/agent-host start"
      : `SESSION_ID=${target} pnpm --filter @trevor/agent-host start`;

  // A known slash command routes to the immediate host lane (runs now, bypassing the
  // model and the queue). Everything else enqueues; the drain effect publishes when
  // idle, so a second prompt during a turn waits its turn instead of firing at once.
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The prompt shell lane (D-082): a RAW leading `!` runs a shell command immediately on the host,
    // bypassing the send queue, the model, and the provider flow. Checked before the trim/slash path
    // so a space before `!` stays an ordinary prompt. Shell is text-only: any pending attachments are
    // left in the composer (handled explicitly, never silently dropped) for the user's next prompt.
    const bang = parseBangShell(draft);
    if (bang) {
      history.record(draft); // recall the bang command as typed (D-084)
      setDraft("");
      void shell(crypto.randomUUID(), bang.command);
      scroll.pinToBottom(); // re-pin: follow the shell block + its output down to the bottom
      return;
    }
    const text = draft.trim();
    // `/resume` is a browser-side UI command (D-090): it opens the resume chooser, never a
    // model turn and never a host round-trip, so it's intercepted before the host command
    // lane. It injects no transcript content into the current session.
    if (text === "/resume" || text.startsWith("/resume ")) {
      history.resetNavigation();
      setDraft("");
      modal.setResumeOpen(true);
      return;
    }
    // `/worktree` is a browser-side UI command (D-091): it opens the worktree switcher; the actual
    // switch routes the host-owned action, never a model turn.
    if (text === "/worktree" || text.startsWith("/worktree ")) {
      history.resetNavigation();
      setDraft("");
      modal.setWorktreeOpen(true);
      return;
    }
    // A slash command (text only) routes to the immediate host lane. Otherwise a prompt
    // may carry text, attachments, or both - attachments-only is a valid "look at this".
    const cmd = text ? parseCommand(text, commandNames) : null;
    if (cmd) {
      // A slash command result is host output, excluded from prompt recall (D-084) - just reset any
      // in-progress history navigation so the next ArrowUp starts fresh.
      history.resetNavigation();
      setDraft("");
      void command(cmd.command, cmd.args);
      scroll.pinToBottom(); // re-pin: follow the command + its result down to the bottom
      return;
    }
    if (!text && imageRefs.length === 0 && attachments.length === 0) {
      return;
    }
    history.record(text); // record ordinary prompts for recall (empty/attachments-only is skipped)
    setDraft(""); // clears the draft text AND its image-token refs (via the composer's syncDraft)
    // Image refs (token order) ride first so the host maps token #k -> the k-th image artifact;
    // document attachments follow as a note.
    const all = [...imageRefs, ...attachments];
    const artifacts = all.length ? all : undefined;
    setAttachments([]);
    submit({
      id: crypto.randomUUID(),
      text,
      provider: activeProvider,
      reasoning: reasoning || undefined,
      model: sendModelRef,
      artifacts,
    });
    // Re-pin to the bottom on submit, even if scrolled up: the follow effect then snaps to each
    // new item (the prompt when its event round-trips, then the streaming answer) and holds there.
    scroll.pinToBottom();
  };

  // Slash-menu key handling on the composer, active only while the menu is open:
  // arrows move the highlight, Tab/Enter complete it, Esc dismisses (and is swallowed
  // so the window ESC cancel/steer handler doesn't also fire). An exact match + Enter
  // falls through to submit, so a fully-typed command runs on one Enter.
  // Recall a history entry into the composer and park the caret at its end, so the next ArrowUp/Down
  // continues navigation from a known position (a single-line recall stays on the first+last line).
  const recallInto = (el: HTMLTextAreaElement, text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      el.selectionStart = text.length;
      el.selectionEnd = text.length;
    });
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenu.onMenuKeyDown(event)) {
      return;
    }

    const el = event.currentTarget;
    // Menu closed: in a textarea Enter inserts a newline, so submit explicitly. Enter
    // sends; Shift+Enter keeps the newline (for multi-line prompts and quoted blocks).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      el.form?.requestSubmit();
      return;
    }
    // Prompt history recall (D-084). ArrowUp recalls the previous prompt from the first line (or an
    // empty composer); ArrowDown steps forward while navigating, from the last line. Off the first/
    // last line, multi-line editing keeps normal caret movement (no preventDefault).
    const caret = el.selectionStart ?? 0;
    if (event.key === "ArrowUp" && caretOnFirstLine(el.value, caret)) {
      const recalled = history.recallPrev(draft);
      if (recalled !== null) {
        event.preventDefault();
        recallInto(el, recalled);
      }
      return;
    }
    if (event.key === "ArrowDown" && history.navigating && caretOnLastLine(el.value, caret)) {
      const recalled = history.recallNext();
      if (recalled !== null) {
        event.preventDefault();
        recallInto(el, recalled);
      }
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
    // prompt that replaces the queue, then ask the host to cancel the active run. The draft's
    // image-token refs ride with the document attachments so a steered prompt keeps its images.
    steer(draft, [...imageRefs, ...attachments], {
      id: crypto.randomUUID(),
      provider: activeProvider,
      reasoning: reasoning || undefined,
      model: sendModelRef,
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
  // A modal/picker/takeover (model chooser, resume, worktree switcher) owns Escape while open -
  // it closes itself, and the turn on the transcript behind it must NOT be cancelled.
  const modalOpen = chooserOpen || modal.resumeOpen || modal.worktreeOpen;
  const escRef = useRef({
    active,
    awaiting: awaitingResponse,
    compacting,
    draft,
    modalOpen,
    setDraft,
    onCancel,
    resetHistory: history.resetNavigation,
  });
  escRef.current = {
    active,
    awaiting: awaitingResponse,
    compacting,
    draft,
    modalOpen,
    setDraft,
    onCancel,
    resetHistory: history.resetNavigation,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const s = escRef.current;
      const action = escapeAction({
        active: s.active,
        awaiting: s.awaiting,
        compacting: s.compacting,
        draft: s.draft,
        modalOpen: s.modalOpen,
      });
      // A turn to cancel, OR a manual fold to abort - either routes through onCancel.
      if (action === "cancel") {
        event.preventDefault();
        s.onCancel();
      } else if (action === "clear-draft") {
        event.preventDefault();
        s.setDraft("");
        s.resetHistory(); // clearing the composer ends any in-progress history navigation
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Model + reasoning + thinking controls, moved out of the footer into the panel.
  const panelControls = (
    <ControlsPanel
      config={{
        model: {
          activeLabel,
          quickGroups: selection.quickGroups,
          sourceLabels: selection.sourceLabels,
          modelLabels: selection.modelLabels,
          activeModel: sendModel,
          onOpenChooser: () => setChooserOpen((open) => !open),
          onSelectModel,
        },
        reasoning: {
          levels: activeReasoningLevels,
          selected: activeReasoning,
          onChange: setReasoning,
        },
        thinking: {
          show: showThinkingOn,
          onShowChange: setShowThinking,
        },
      }}
    />
  );

  // The full model chooser (D-065 M2/M3): a takeover of the transcript/composer space (the sidebars
  // stay visible), opened from the split control's left region. Source overview -> per-source model
  // browse; picking a model routes through the same onSelectModel the quick picker uses. Rendered only
  // while open so it never costs anything in the common case.
  const chooser = chooserOpen ? (
    <div className="flex h-full flex-col">
      {/* A back arrow on the upper LEFT returns to the chat without changing the selection (the model
        button also toggles the chooser closed). The chooser's own "Choose a model" heading is the title. */}
      <div className="flex shrink-0 items-center px-1 py-2">
        <button
          type="button"
          onClick={() => setChooserOpen(false)}
          aria-label="Back to chat"
          className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-label tracking-wider uppercase text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back
        </button>
      </div>
      <ModelChooser
        className="min-h-0 flex-1"
        sources={selection.sources}
        catalogBySource={selection.catalogBySource}
        activeModel={sendModel}
        recentKeys={selection.recentKeys}
        pinnedKeys={selection.pinnedKeys}
        onTogglePin={selection.togglePin}
        deviceCode={signInDeviceCode}
        deviceCodeSourceId={signIn?.sourceId}
        onSubmitCode={(code) => void submitSignInCode(code)}
        onSelectModel={onSelectModel}
        onSourceAction={(id, action) => {
          // refresh re-queries each source's live /models; authenticate/re-authenticate runs the
          // host-owned OAuth device-code sign-in (D-065 M5). configure (add an API key) stays manual
          // - the host store, never a paste form.
          if (action === "refresh") {
            void refreshCatalog();
          } else if (action === "authenticate" || action === "reauthenticate") {
            void signInSource(id);
          }
        }}
      />
    </div>
  ) : undefined;

  // Session affordances, rendered inline at the bottom of the sidebar (not a floating bar): open the
  // resume chooser, the worktree switcher (when any exist), and the session id for orientation.
  const panelFooter = (
    <>
      <button
        type="button"
        onClick={() => modal.setResumeOpen(true)}
        title="Resume a session (/resume)"
        aria-label="Resume a session"
        className="flex cursor-pointer items-center gap-1 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-muted-foreground hover:text-foreground"
      >
        <History className="size-3" />
        resume
      </button>
      {modal.worktrees.length > 0 ? (
        <button
          type="button"
          onClick={() => modal.setWorktreeOpen(true)}
          title="Switch worktree (/worktree)"
          aria-label="Switch worktree"
          className="flex cursor-pointer items-center gap-1 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-muted-foreground hover:text-foreground"
        >
          <GitBranch className="size-3" />
          worktree
        </button>
      ) : null}
      <div className="ml-auto truncate rounded border border-border bg-background px-2 py-1 font-mono text-label tracking-wider text-muted-foreground">
        {target}
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
    <PanelHost
      composer={composer}
      compose={{
        onSubmit,
        onInputKeyDown,
        menuOpen: slashMenu.menuOpen,
        menuMatches: slashMenu.menuMatches,
        menuIndex: slashMenu.menuIndex,
        slashQuery: slashMenu.slashQuery,
        acceptCommand: slashMenu.acceptCommand,
        disabled: !sessionId,
        placeholder: `message ${activeLabel}… (/ for commands, ! for shell)`,
      }}
      stream={stream}
      host={host}
      transcript={{
        transcript,
        toolBatches,
        toConcurrentTool,
        onOpenPath: (path) => void openInEditor(path),
        onDoctorRefresh: () => void command("/doctor", "refresh"),
        showThinking: showThinkingOn,
        active,
        awaitingResponse,
        turnStartedAt,
        queue: visibleQueue,
      }}
      scroll={scroll}
      tasks={tasks}
      panel={{
        // Preserve the original truthiness gate verbatim: an unset (undefined) value renders the
        // panel closed exactly as the prior `{panelOpen ? … }` / `{!panelOpen ? … }` checks did.
        open: modal.panelOpen,
        onOpen: () => modal.setPanelOpen(true),
        onClose: () => modal.setPanelOpen(false),
        title: target,
        subtitle: `${status}${replayed ? " · replayed" : ""} · ${events.length} events`,
        statusNode,
        workspace: host.cwd ?? host.workspace ?? undefined,
        git: host.git,
        model: panel,
        controls: panelControls,
        footer: panelFooter,
        ready: replayed,
      }}
      choosers={{
        resumeOpen: modal.resumeOpen,
        setResumeOpen: modal.setResumeOpen,
        worktreeOpen: modal.worktreeOpen,
        setWorktreeOpen: modal.setWorktreeOpen,
        inventory: modal.inventory,
        resumeContext: {
          currentSessionId: sessionId,
          currentProject: modal.currentProject,
          busy,
          nowMs: now,
        },
        onResume: navigateToSession,
        worktrees: modal.worktrees,
        worktreeContext: { activityBySession: modal.worktreeActivity, busy },
        onSwitchWorktree: (id) => void command("/worktree-switch", id),
      }}
      sidebar={{
        open: modal.sidebarOpen,
        onOpen: () => modal.setSidebarOpen(true),
        onClose: () => modal.setSidebarOpen(false),
        sessions: modal.inventory.sessions,
        currentSessionId: target,
        currentProject: modal.currentProject,
        // Same safe switch path as `/resume` (D-093 M4): navigateToSession syncs `?session=` and
        // resets the per-session draft/queue/history via the sessionId-keyed hooks. Switching is
        // ALWAYS allowed, even while a turn runs - the run keeps going on the host (its events stay in
        // the durable log and replay on return); the row's activity bar shows it from the other view.
        onSelect: navigateToSession,
        onRename: (id, title) => void renameSession(id, title),
        onArchive: (id) => void archiveSession(id),
        onDelete: (id) => void deleteSession(id),
        liveActivity: modal.sidebarLiveActivity,
        nowMs: now,
      }}
      sessionName={sessionName}
      chooser={chooser}
      archived={archived}
      onUnarchive={() => void unarchive()}
      question={{
        pending: pendingQuestion,
        onAnswer: (answer) => {
          if (pendingQuestion) {
            void answerQuestion(pendingQuestion.questionId, answer);
          }
        },
      }}
    />
  );
}
