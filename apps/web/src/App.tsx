import { useQuery } from "@tanstack/react-query";
import { DEFAULT_SESSION_ID } from "@trevor/session";
import { useInterval, useLocalStorageState } from "ahooks";
import { GitBranch, History } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type SubmitEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConcurrentTool } from "@/components/chat/concurrent-tools";
import type { ToolStatus } from "@/components/chat/message";
import { parseToolArgs } from "@/components/chat/tool-message";
import { PanelHost } from "@/components/panel/PanelHost";
import { PanelControls } from "@/components/panel/panel-controls";
import { caretOnFirstLine, caretOnLastLine } from "./composer-caret";
import {
  activeRunId,
  activeTurnStartedAt,
  commandsFrom,
  defaultProviderFrom,
  hostStatus,
  latestSessionSwitch,
  parseBangShell,
  parseCommand,
  providerModelsFrom,
  tasksFrom,
  toolSummary,
  worktreesFrom,
} from "./derive";
import { useComposer } from "./hooks/use-composer";
import { useDraftPersistence } from "./hooks/use-draft-persistence";
import { usePromptHistory } from "./hooks/use-prompt-history";
import { useSendQueue } from "./hooks/use-send-queue";
import { useInventory } from "./resume";
import { atBottomOf } from "./scroll";
import { ensureSession, useSession, useSessionActions, webTabId } from "./session/use-session";
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
  const { publish, cancel, command, shell, openInEditor } = useSessionActions(sessionId);

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
  // The explicit-resume chooser (D-090): a UI affordance / `/resume`, never an implicit resume.
  // The inventory is fetched only while the modal is open; the current session's base repo
  // orders + groups its sessions first.
  const [resumeOpen, setResumeOpen] = useState(false);
  // The managed-worktree switcher (D-091): a UI affordance / `/worktree` opens it; the host
  // announces the worktrees on host.online, and switching routes the host-owned switch action.
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  // The session inventory powers the resume chooser AND decorates worktree rows (activity/host),
  // so fetch it while either chooser is open.
  const inventory = useInventory(resumeOpen || worktreeOpen);
  const currentProject = useMemo(() => {
    const base = (host.workspace ?? host.cwd)?.split("/").filter(Boolean).pop();
    return base && base !== "~" ? base : null;
  }, [host.workspace, host.cwd]);
  const worktrees = useMemo(() => worktreesFrom(events), [events]);
  // Cross-reference per-worktree-session activity from the inventory, so a worktree row can show
  // "agents running" / "needs you" / host presence.
  const worktreeActivity = useMemo(() => {
    const map = new Map<
      string,
      { host: "live" | "stale" | "none"; activity: "running" | "idle" }
    >();
    for (const s of inventory.sessions) {
      map.set(s.sessionId, { host: s.host, activity: s.activity });
    }
    return map;
  }, [inventory.sessions]);
  const hostModels = useMemo(() => providerModelsFrom(events), [events]);
  // The host-announced default provider; the initial selection falls back to it when the
  // user hasn't chosen one, rather than to a hardcoded key.
  const hostDefault = useMemo(() => defaultProviderFrom(events), [events]);
  const active = useMemo(() => activeRunId(events), [events]);
  // The in-flight turn's start time (ms epoch), driving the live "Working (elapsed)" timer.
  const turnStartedAt = useMemo(() => activeTurnStartedAt(events), [events]);
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
  const commandSpecs = useMemo(() => {
    const announced = new Set(commands.map((c) => c.name));
    return [...BUILT_IN_COMMANDS.filter((c) => !announced.has(c.name)), ...commands];
  }, [commands]);
  const commandNames = useMemo(() => new Set(commandSpecs.map((c) => c.name)), [commandSpecs]);
  // Slash menu: open while the draft is a bare "/token" (no space yet) with matches,
  // unless Esc dismissed it for exactly this text. menuIndex is the highlighted row. (inputRef is
  // the composer textarea ref, owned by useComposer.)
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissedFor, setMenuDismissedFor] = useState<string | null>(null);
  const slashQuery = draft.startsWith("/") && !draft.includes(" ") ? draft : null;
  const menuMatches = useMemo(
    () => (slashQuery ? commandSpecs.filter((c) => c.name.startsWith(slashQuery)) : []),
    [slashQuery, commandSpecs],
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
  const busy = active !== null || awaitingResponse;
  const { queue, submit, steer } = useSendQueue({ busy, publish, resetKey: sessionId });

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
    // The prompt shell lane (D-082): a RAW leading `!` runs a shell command immediately on the host,
    // bypassing the send queue, the model, and the provider flow. Checked before the trim/slash path
    // so a space before `!` stays an ordinary prompt. Shell is text-only: any pending attachments are
    // left in the composer (handled explicitly, never silently dropped) for the user's next prompt.
    const bang = parseBangShell(draft);
    if (bang) {
      history.record(draft); // recall the bang command as typed (D-084)
      setDraft("");
      void shell(crypto.randomUUID(), bang.command);
      setAtBottom(true); // re-pin: follow the shell block + its output down to the bottom
      return;
    }
    const text = draft.trim();
    // `/resume` is a browser-side UI command (D-090): it opens the resume chooser, never a
    // model turn and never a host round-trip, so it's intercepted before the host command
    // lane. It injects no transcript content into the current session.
    if (text === "/resume" || text.startsWith("/resume ")) {
      history.resetNavigation();
      setDraft("");
      setResumeOpen(true);
      return;
    }
    // `/worktree` is a browser-side UI command (D-091): it opens the worktree switcher; the actual
    // switch routes the host-owned action, never a model turn.
    if (text === "/worktree" || text.startsWith("/worktree ")) {
      history.resetNavigation();
      setDraft("");
      setWorktreeOpen(true);
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
      setAtBottom(true); // re-pin: follow the command + its result down to the bottom
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
    const selected = menuOpen ? menuMatches[menuIdx] : undefined;
    if (!selected) {
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
        return;
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
    // prompt that replaces the queue, then ask the host to cancel the active run. The draft's
    // image-token refs ride with the document attachments so a steered prompt keeps its images.
    steer(draft, [...imageRefs, ...attachments], {
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
    resetHistory: history.resetNavigation,
  });
  escRef.current = {
    active,
    awaiting: awaitingResponse,
    compacting,
    draft,
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
      const runId = s.active ?? (s.awaiting ? "" : null);
      // A turn to cancel, OR a manual fold to abort - either routes through onCancel.
      if (runId !== null || s.compacting) {
        event.preventDefault();
        s.onCancel();
      } else if (s.draft) {
        event.preventDefault();
        s.setDraft("");
        s.resetHistory(); // clearing the composer ends any in-progress history navigation
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The transcript well is a normal top-down column (D-086): an empty or short session sits at the
  // TOP padding and appends downward, instead of bottom-aligning above the composer. "At the live
  // edge" is therefore the distance from the BOTTOM (scrollHeight - clientHeight - scrollTop within
  // tolerance), not scrollTop 0 - see scroll.ts. We follow the bottom only while already pinned, so
  // streaming output never yanks the viewport when the user has scrolled up; a jump-to-bottom chevron
  // shows when away from the edge and scrolls back down.
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Mirror atBottom into a ref so the ResizeObserver callback below reads the latest value without
  // re-subscribing on every change.
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  const onTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (el) {
      setAtBottom(atBottomOf(el));
    }
  };
  const scrollToBottom = () =>
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  // Follow the bottom while pinned: when `atBottom`, snap to the newest content on EVERY transcript
  // update - a streaming answer, a burst of tool rows, or the two events a /compact appends (the
  // command then its result) all keep the view at the bottom, not just the first one. Instant (no
  // smooth) so it tracks tightly without lagging behind a fast stream. An existing session opens at
  // the bottom (atBottom starts true → the first populated render scrolls to scrollHeight); an empty
  // session's scrollHeight ≈ clientHeight, so the scroll is a no-op and content stays at the top.
  // Scrolling up flips `atBottom` off (onTranscriptScroll) and stops the follow; a submit re-arms it
  // via setAtBottom(true). useLayoutEffect (not useEffect) so the scroll lands BEFORE paint: on a
  // reload the full history commits in one update (see use-session's replay buffer), and scrolling
  // pre-paint puts the view at the bottom on the first frame instead of flashing the top first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `transcript` is the trigger (not read) - re-pin on each update while at the bottom.
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (atBottom && el) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [transcript, atBottom]);
  // Re-pin to the bottom as content SETTLES after a reload (or a fast stream): markdown, images, and
  // collapsible thinking sections grow the scroll height AFTER the initial layout, which would
  // otherwise leave a reload stranded mid-way (the one scroll-to-bottom fired before the content
  // reached its final height). A ResizeObserver on the content re-scrolls to the bottom whenever it
  // grows while we're meant to be pinned; scrolling up flips atBottom off and stops the re-pin.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach when the transcript content mounts (replayed/host gate); atBottom is read via the ref.
  useEffect(() => {
    const content = contentRef.current;
    const container = transcriptRef.current;
    if (!content || !container) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) {
        container.scrollTo({ top: container.scrollHeight });
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [replayed, host.leaderId, transcript.length === 0]);

  // Model + reasoning + thinking controls, moved out of the footer into the panel.
  const panelControls = (
    <PanelControls
      models={modelOptions}
      activeProvider={activeProvider}
      onProviderChange={setProvider}
      reasoningLevels={modelMeta.reasoningLevels}
      reasoning={reasoning}
      onReasoningChange={setReasoning}
      showThinking={showThinkingOn}
      onShowThinkingChange={setShowThinking}
    />
  );

  // Session affordances, rendered inline at the bottom of the sidebar (not a floating bar): open the
  // resume chooser, the worktree switcher (when any exist), and the session id for orientation.
  const panelFooter = (
    <>
      <button
        type="button"
        onClick={() => setResumeOpen(true)}
        title="Resume a session (/resume)"
        aria-label="Resume a session"
        className="flex cursor-pointer items-center gap-1 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-muted-foreground hover:text-foreground"
      >
        <History className="size-3" />
        resume
      </button>
      {worktrees.length > 0 ? (
        <button
          type="button"
          onClick={() => setWorktreeOpen(true)}
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
        menuOpen,
        menuMatches,
        menuIndex: menuIdx,
        slashQuery,
        acceptCommand,
        disabled: !sessionId,
        placeholder: `message ${modelMeta.label}… (/ for commands, ! for shell)`,
      }}
      stream={stream}
      host={host}
      transcript={{
        transcript,
        toolBatches,
        toConcurrentTool,
        onOpenPath: (path) => void openInEditor(path),
        showThinking: showThinkingOn,
        active,
        awaitingResponse,
        turnStartedAt,
        queue,
      }}
      scroll={{
        transcriptRef,
        contentRef,
        atBottom,
        onScroll: onTranscriptScroll,
        scrollToBottom,
      }}
      tasks={tasks}
      panel={{
        // Preserve the original truthiness gate verbatim: an unset (undefined) value renders the
        // panel closed exactly as the prior `{panelOpen ? … }` / `{!panelOpen ? … }` checks did.
        open: Boolean(panelOpen),
        onOpen: () => setPanelOpen(true),
        onClose: () => setPanelOpen(false),
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
        resumeOpen,
        setResumeOpen,
        worktreeOpen,
        setWorktreeOpen,
        inventory,
        resumeContext: { currentSessionId: sessionId, currentProject, busy, nowMs: now },
        onResume: navigateToSession,
        worktrees,
        worktreeContext: { activityBySession: worktreeActivity, busy },
        onSwitchWorktree: (id) => void command("/worktree-switch", id),
      }}
    />
  );
}
