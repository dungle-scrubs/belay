import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_SESSION_ID,
  type LoopControl,
  type ModelRef,
  PRODUCER_IDS,
  SUPERVISOR_SESSION_ID,
  tangentsOf,
} from "@trevor/session";
import { useInterval, useLocalStorageState } from "ahooks";
import { Archive, GitBranch, RotateCcw } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type SubmitEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LiveAgentDetail } from "@/agent-detail/live-agent-detail";
import { ArchiveBrowser } from "@/archive/archive-browser";
import { buildArchiveRows } from "@/archive/archive-rows";
import { useArchiveActions } from "@/archive/use-archive-actions";
import {
  type ArtifactPanelState,
  artifactId,
  closeArtifactPanel,
  createArtifactPanelState,
  openArtifactPanel,
  resetArtifactPanelPreference,
  resizeArtifactPanel,
} from "@/artifact-panel/artifact-panel-state";
import type { LucidPanelWiring } from "@/artifact-panel/lucid/lucid-viewer";
import type { TangentSelection } from "@/components/assistant-ui/quote-selection-toolbar";
import { useLoopInventory } from "@/components/chat/loop/use-loop-inventory";
import { loopPreviewForLine } from "@/components/chat/loop/use-loop-preview";
import { ModelChooser } from "@/components/chooser/model-chooser";
import { sourceActionCommand } from "@/components/chooser/source-action";
import { CommandPalette } from "@/components/command-palette/command-palette";
import type { PaletteCommand } from "@/components/command-palette/palette-commands";
import { BackToChat } from "@/components/panel/back-to-chat";
import { ControlsPanel } from "@/components/panel/panel-controls";
import { PanelHost } from "@/components/panel/panel-host";
import { PromptSurfaceEditor } from "@/components/panel/prompt-surface-editor";
import { ShortcutsHelp } from "@/components/shortcuts-help/shortcuts-help";
import { sessionScopedKey } from "@/model-selection";
import { HostLaunchStatus } from "@/new-session/host-launch-status";
import { isNewSessionCommand, NEW_SESSION_COMMAND } from "@/new-session/new-session-command";
import { NewSessionPicker } from "@/new-session/new-session-picker";
import { useLaunch } from "@/new-session/use-launch";
import { useSupervisor } from "@/new-session/use-supervisor";
import { isComposerSubmitKey } from "@/shortcuts/composer-submit";
import { formatChord } from "@/shortcuts/keys";
import { type ShortcutId, shortcut } from "@/shortcuts/registry";
import { isEditableTarget, useShortcutRouter } from "@/shortcuts/router";
import { useProjectSidebar } from "@/sidebar/use-project-sidebar";
import { useSidebarSupervisor } from "@/sidebar/use-sidebar-supervisor";
import {
  jobDismissEligible,
  jobToDetailModel,
  runningSubagents,
} from "@/support-panel/support-panel";
import { type FoldBackContent, foldBackPreview } from "@/tangent/foldback";
import { LiveTangentShell } from "@/tangent/live-tangent-shell";
import { TangentDiscovery } from "@/tangent/tangent-discovery";
import { type ActiveTangent, useTangent } from "@/tangent/use-tangent";
import { findDetailModel, isDetailEligible } from "@/tool-detail/detail-model";
import { ToolDetailView } from "@/tool-detail/tool-detail-view";
import { vimToggleCommand } from "@/vim/vim-command";
import { BUILT_IN_COMMANDS } from "./built-in-commands";
import { activeMention } from "./composer/active-mention";
import { type FileIndexAsked, shouldRequestFileIndex } from "./composer/file-index-request";
import { caretOnFirstLine, caretOnLastLine } from "./composer-caret";
import {
  detectOrphanedSubagents,
  detectOrphanedTurn,
  jobsFrom,
  parseBangShell,
  parseCommand,
  resolveKnownRoot,
  unreconciledSubagents,
} from "./derive";
import { type EscState, escapeAction } from "./esc-action";
import { useActiveModel } from "./hooks/use-active-model";
import { useComposer } from "./hooks/use-composer";
import { useDraftPersistence } from "./hooks/use-draft-persistence";
import { useFileMentionMenu } from "./hooks/use-file-mention-menu";
import { useModalState } from "./hooks/use-modal-state";
import { usePromptEditor } from "./hooks/use-prompt-editor";
import { usePromptHistory } from "./hooks/use-prompt-history";
import { useScrollFollow } from "./hooks/use-scroll-follow";
import { useSendQueue } from "./hooks/use-send-queue";
import { useSlashMenu } from "./hooks/use-slash-menu";
import { useFileIndex, useWorkspaceFileSearch } from "./hooks/use-workspace-file-search";
import { createSessionReadModel } from "./session/projection";
import {
  selectHostlessPending,
  selectHostStatus,
  selectSessionName,
  selectTabTitle,
  selectTurnStatusHeader,
} from "./session/selectors";
import {
  archiveSession,
  ensureSession,
  permanentlyDeleteSession,
  recordTangentFoldBack,
  sessionTransport,
  useSession,
  useSessionActions,
  useSessionWithTransport,
  webTabId,
} from "./session/use-session";
import type { Message } from "./transcript";

const PROVIDER_KEY = "trevor.provider";
// Per-provider chosen reasoning level, and whether to render thinking text at all.
const REASONING_KEY = "trevor.reasoning";
const SHOW_THINKING_KEY = "trevor.showThinking";
const ARTIFACT_PANEL_KEY = "trevor.artifactPanel";
// Host and browser default to one shared session so they auto-attach with no manual
// wiring; override with ?session=<id> in the URL. The id is owned in @trevor/session so
// this and the host's SESSION_ID default cannot drift into two different sessions.
const DEFAULT_SESSION = DEFAULT_SESSION_ID;
/** Commands that still WORK when typed but are hidden from the slash autocomplete menu (a dev toggle
 *  the host always announces; we don't want it cluttering the picker). Stays in `commandNames` so
 *  `parseCommand` routes it as a command, just filtered out of the menu list. */
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set(["/debug"]);

function targetFromLocation(): string {
  return new URLSearchParams(window.location.search).get("session") ?? DEFAULT_SESSION;
}

function urlForSession(sessionId: string): URL {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  return url;
}

/** A palette command for an app action that also has a keyboard shortcut: its label + chord are read
 *  from the shortcut registry (single source), so the palette can never drift from the router (plan 07). */
function shortcutCommand(
  id: ShortcutId,
  run: () => void,
  extra?: Partial<PaletteCommand>,
): PaletteCommand {
  const spec = shortcut(id);
  return { id, label: spec.label, keys: formatChord(spec.keys), run, ...extra };
}

// The local send queue + hard-steer fold (QueuedPrompt, sendQueueReducer, foldSteer)
// live in ./send-queue, unit-tested without React; the React state machine that drives
// them (the busy/in-flight latch + release/drain effects) lives in ./hooks/use-send-queue.
const rawString = { serializer: (value: string) => value, deserializer: (value: string) => value };
const artifactPanelStorage = {
  serializer: (value: ArtifactPanelState) => JSON.stringify(value),
  deserializer: (value: string): ArtifactPanelState => {
    try {
      const parsed = JSON.parse(value) as Partial<ArtifactPanelState>;
      return {
        ...createArtifactPanelState(parsed.preference),
        open: parsed.open ?? false,
        selectedArtifactId: parsed.selectedArtifactId ?? null,
      };
    } catch {
      return createArtifactPanelState();
    }
  },
};

// How long an in-flight turn may go silent with no leader host connected before the browser recovers
// it (see detectOrphanedTurn). Comfortably longer than the host's own reconnect-reconcile window, so a
// host that is merely restarting finishes its turn first; short enough that a truly dead session does
// not leave a phantom "Working" spinner for long. The live clock ticks every 4s, so detection lands
// within ~4s of crossing this.
const ORPHAN_GRACE_MS = 12_000;

/** The Escape inputs the window listener reads, plus the handlers it routes to (see escRef below). */
interface EscRefShape extends EscState {
  readonly setDraft: (value: string) => void;
  readonly onCancel: () => void;
  readonly onFlushQueuedSteer: () => void;
  readonly onDismissHandoff: () => void;
  readonly resetHistory: () => void;
}

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
    queryKey: ["tether-session", target],
    queryFn: async () => {
      await ensureSession(target);
      return target;
    },
  });
  const sessionId = sessionQuery.data ?? null;

  // Model state (provider / reasoning / show-thinking / preferences) is keyed PER SESSION so changing
  // the model in one session never live-switches another (02.16 D-002): localStorage is origin-shared
  // and ahooks syncs it cross-tab, so a global key leaked across every open session. ahooks re-reads on
  // a key change, so switching sessions loads that session's own state; two tabs on the same session
  // still share. No default here: an unset provider falls through to the host-announced default.
  const [provider, setProvider] = useLocalStorageState<string>(
    sessionScopedKey(PROVIDER_KEY, sessionId),
    rawString,
  );
  const [reasoningMap, setReasoningMap] = useLocalStorageState<Record<string, string>>(
    sessionScopedKey(REASONING_KEY, sessionId),
    { defaultValue: {} },
  );
  const [showThinking, setShowThinking] = useLocalStorageState<boolean>(
    sessionScopedKey(SHOW_THINKING_KEY, sessionId),
    { defaultValue: true },
  );
  // Compact transcript layout (plan 05): a display-only toggle that collapses non-primary rows to one
  // line. Kept session-local (plain state, not persisted) - a persisted preference is deferred to the
  // settings/keyboard plan per the plan's escape hatch.
  const [compact, setCompact] = useState(false);
  const [artifactPanel, setArtifactPanel] = useLocalStorageState<ArtifactPanelState>(
    sessionScopedKey(ARTIFACT_PANEL_KEY, sessionId),
    { defaultValue: createArtifactPanelState(), ...artifactPanelStorage },
  );
  // The Mod+K command palette (plan 07): a frontmost overlay; while open it owns its keys.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // The composer's local state as one boundary: draft, pending attachments + upload state, refs, and
  // the file-intake handlers. App keeps the submit/steer/slash-menu wiring (send queue + commands)
  // and passes the whole `composer` object to PanelHost; it also reads a few fields here for that
  // wiring (the submit path clears the draft/attachments, the slash menu refocuses the input, etc.).
  const composer = useComposer();
  const { draft, setDraft, imageRefs, pastes, attachments, setAttachments, inputRef } = composer;

  const stream = useSession(sessionId);
  const { events, presence, replayed, replayThroughSeq, status } = stream;
  const {
    publish,
    supersede,
    cancel,
    switchModel,
    command,
    shell,
    requestFileIndex,
    openInEditor,
    refreshCatalog,
    setModelDefault,
    toggleModelFavorite,
    signInSource,
    submitSignInCode,
    unarchive,
    answerQuestion,
    reconcileTurn,
    reconcileSubagent,
    approveHandoff,
    rejectHandoff,
    deliverLucidFeedback,
    setLucidReview,
  } = useSessionActions(sessionId);

  // Tab-local composer recovery + history (D-083/D-084), keyed by this tab's id + the session id and
  // kept in sessionStorage (tab-scoped, survives a reload). Draft persistence restores an unsubmitted
  // draft; prompt history records published prompts + bang commands for ArrowUp/ArrowDown recall.
  const tabId = useMemo(() => webTabId(), []);
  useDraftPersistence({ storage: window.sessionStorage, tabId, sessionId, draft, setDraft });
  const history = usePromptHistory({ storage: window.sessionStorage, tabId, sessionId });
  // The read model owns the full-log folds that app surfaces consume. Raw events remain available for
  // compatibility paths that still need the event stream during the rest of this plan.
  const readModel = useMemo(() => createSessionReadModel(events, { replayed }), [events, replayed]);
  const transcript = readModel.transcript;
  const transcriptArtifacts = readModel.transcriptArtifacts;
  const lucidReview = readModel.lucidReview;
  const artifactPanelOpen = artifactPanel?.open ?? false;
  const selectedArtifactId = artifactPanel?.selectedArtifactId ?? null;
  const selectedPanelArtifact = useMemo(
    () =>
      artifactPanelOpen && selectedArtifactId !== null
        ? (transcriptArtifacts.find((artifact) => artifactId(artifact) === selectedArtifactId) ??
          null)
        : null,
    [artifactPanelOpen, selectedArtifactId, transcriptArtifacts],
  );
  const selectedLucidWiring = useMemo<LucidPanelWiring | undefined>(() => {
    const meta = selectedPanelArtifact?.lucid;
    if (!meta) {
      return undefined;
    }
    return {
      delivered: lucidReview.get(meta.lucidId) ?? null,
      onDeliver: (batch) => void deliverLucidFeedback(batch),
      onReviewChange: (resolved) =>
        void setLucidReview(
          meta.lucidId,
          resolved,
          (lucidReview.get(meta.lucidId)?.lastCursor ?? 0) + 1,
        ),
    };
  }, [selectedPanelArtifact, lucidReview, deliverLucidFeedback, setLucidReview]);
  const switchTarget = useMemo(
    () => readModel.switchAfterReplay(replayThroughSeq),
    [readModel, replayThroughSeq],
  );
  useEffect(() => {
    if (switchTarget && switchTarget !== target) {
      navigateToSession(switchTarget);
    }
  }, [navigateToSession, switchTarget, target]);
  // Runs of 2+ consecutive read-only tool rows were one concurrent batch (D-050); group them so
  // they render as a single compact block instead of stacked cards.
  const toolBatches = readModel.toolBatches;
  const scroll = useScrollFollow(transcript.length);
  const awaitingResponse = readModel.awaitingResponse;
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 4000);
  const announcement = readModel.announcement;
  const host = useMemo(
    () => selectHostStatus(readModel, presence, now),
    [readModel, presence, now],
  );
  // Reflect WHERE we are in the tab/window title (not a bare "Trevor"): the project name - the
  // host-announced workspace basename when known, else the session-id slug (the `<name>-<hash>` the
  // launcher mints, hash stripped). The default shared session stays plain "Trevor".
  useEffect(() => {
    document.title = selectTabTitle({ workspace: host.workspace }, target, DEFAULT_SESSION);
  }, [host.workspace, target]);
  const hostModels = readModel.providerModels;
  // The host-owned model sources + catalog (D-065): the real provider/runtime/subscription list with
  // auth state and each configured source's live model catalog. Empty until the host's first catalog
  // load re-announces, so the chooser falls back to the roster projection until then.
  const hostSources = readModel.sources;
  const hostCatalog = readModel.catalog;
  // The host-owned model preference (plan 51): the durable default + favorites the chooser reads and the
  // fresh-session pick starts on. Empty until a host announces (then default/favorites come from here,
  // not a per-browser blob).
  const hostModelPrefs = readModel.modelPrefs;
  // The in-flight source sign-in (D-065 M5): show the verification URL while the flow is active. A
  // device-code flow (Codex) carries a userCode; a browser+paste flow (Anthropic) carries acceptsCode
  // and the user pastes the returned code back. The `starting` phase (emitted the moment the host
  // receives /source-signin) renders as immediate progress - the login can take seconds to produce
  // its URL, and a silent gap reads as a dead button.
  const signIn = readModel.signIn;
  const signInStarting = signIn?.phase === "starting";
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
  const hostDefault = readModel.defaultProvider;
  // The model/effort this session last ran a turn on (a handoff stamps it onto the first prompt); a
  // fresh session inherits it instead of falling to the host default - the qwen-on-handoff fix (09.1).
  const lastUserModel = readModel.lastUserModel;
  const active = readModel.activeRunId;
  const busy = active !== null || awaitingResponse;
  // Modal, drawer, inventory, and project scoping state are one App-owned view boundary shared by
  // /resume, /worktree, the left session sidebar, and the right details panel.
  const worktrees = readModel.worktrees;
  const modal = useModalState({ worktrees, host, target, sessionId, busy });
  // The archive browser's optional project filter (plan 58 M7): set when the user clicks "View
  // archive" on an archive-only project in the sidebar, so the archive lists only that project's
  // archived sessions. Cleared via the banner's close button or whenever the archive closes.
  const [archiveProjectFilter, setArchiveProjectFilter] = useState<string | null>(null);
  // The single open-picker entry (plan 44.2, D-001): both the sidebar `＋ New session` and the `/new`
  // command call this, so the two entry points can never drift.
  const openNewSession = useCallback(() => modal.setNewOpen(true), [modal.setNewOpen]);
  // On a launched/reused session, close the picker and navigate (the safe switch path). Closing sets
  // newOpen false, which resets the supervisor hook's request/launch state.
  const onLaunchNavigate = useCallback(
    (launchedSessionId: string) => {
      modal.setNewOpen(false);
      navigateToSession(launchedSessionId);
    },
    [modal.setNewOpen, navigateToSession],
  );
  // The New-session picker's live wiring over the 44.1 supervisor control session (plan 44.2 M3/M4).
  // The native folder pick is offered only when a LOCAL backend reports presence (null = remote
  // Tether), degrading to recents + paste-a-path otherwise.
  const localPickerAvailable = presence !== null;
  const supervisor = useSupervisor({
    active: modal.newOpen,
    localPickerAvailable,
    onNavigate: onLaunchNavigate,
  });
  // Session-view "start host" (plan 44.3): the no-host badge can launch a host for the session already
  // in view, driving the SAME launch machine as the picker (useLaunch) so the two surfaces never fork.
  // The supervisor control subscription is armed only once a start is requested (the picker's `active`
  // analogue) - a no-host session viewed idly holds no supervisor stream. The control log replays from
  // seq 0, so a subscription opened the instant the user clicks Start still catches the durable result.
  const [startRequested, setStartRequested] = useState(false);
  const startControl = useSessionWithTransport(
    sessionTransport,
    startRequested ? SUPERVISOR_SESSION_ID : null,
  );
  const sessionLaunch = useLaunch({
    controlEvents: startControl.events,
    onNavigate: navigateToSession,
  });
  // The known root, derived ONCE (plan 44.3 M1.5) from the viewed session's own host announcement (a
  // dead/stale host still latches its workspace/cwd), then the inventory summary, then the supervisor's
  // projects mapping. Only a resolvable root turns the no-host hint into a "start host" affordance;
  // otherwise the session view keeps the plain shell-command hint. (`recents` is populated only while
  // the picker is open, so in the session view this resolves from the log + inventory, which cover any
  // session a host was ever here for.)
  const knownRoot = useMemo(
    () =>
      resolveKnownRoot({
        host,
        summary: modal.inventory.sessions.find((s) => s.sessionId === target),
        project: supervisor.recents.find((p) => p.sessionId === target),
      }),
    [host, modal.inventory.sessions, supervisor.recents, target],
  );
  const onStartHost = useCallback(() => {
    if (knownRoot === null) {
      return;
    }
    setStartRequested(true);
    sessionLaunch.launch(knownRoot);
  }, [knownRoot, sessionLaunch.launch]);
  // `/new <path>` and `/cd <path>` (plan 58 M4): mint a FRESH session id (not the deterministic
  // projectSessionId) and launch a project-scoped session with a session.project marker. The
  // supervisor stamps the marker + touches the registry before spawning the host. Reuses the same
  // useLaunch + control subscription as the session-view "start host" so the two surfaces never fork.
  const startFreshProjectSession = useCallback(
    (projectPath: string) => {
      const sessionId = crypto.randomUUID();
      setStartRequested(true);
      sessionLaunch.launch(projectPath, { sessionId, projectPath });
    },
    [sessionLaunch.launch],
  );
  // Once a host is present (the badge flips to "host active", so the launch UI is gone) or the viewed
  // session changes, disarm the subscription and reset the launch - the reset bumps useLaunch's guard
  // token so a superseded launch's pending host.online never navigates the new session late.
  const resetSessionLaunch = sessionLaunch.reset;
  useEffect(() => {
    if (startRequested && host.present) {
      setStartRequested(false);
      resetSessionLaunch();
    }
  }, [startRequested, host.present, resetSessionLaunch]);
  // Reset the launch (and disarm) whenever the viewed session changes, so a launch started on the
  // previous session cannot navigate the new one late (reset bumps useLaunch's guard token). The ref
  // compare makes `target` a real read, not a trigger-only dep.
  const launchTargetRef = useRef(target);
  useEffect(() => {
    if (launchTargetRef.current !== target) {
      launchTargetRef.current = target;
      setStartRequested(false);
      resetSessionLaunch();
    }
  }, [target, resetSessionLaunch]);
  // The project sidebar (plan 58 M6): a persistent supervisor subscription that fetches the project
  // registry list and dispatches project actions (add/rename/collapse/remove) whenever the sidebar is
  // open. Separate from the picker's useSupervisor (which gates on picker-open + owns the launch
  // machine) because the sidebar needs the project list on its own open gate.
  const sidebarSupervisor = useSidebarSupervisor({ active: modal.sidebarOpen });
  // The sidebar's read model: groups sessions under projects, owns local collapsed/show-more/search
  // state, and exposes the project/session action callbacks. Session selection navigates; New Session
  // per-project reuses the M4 fresh-session launch; Archive publishes session.archived.
  const projectSidebar = useProjectSidebar({
    sessions: modal.inventory.sessions,
    projects: sidebarSupervisor.projects,
    onProjectAction: sidebarSupervisor.onProjectAction,
    onNewSession: (projectKey) => startFreshProjectSession(projectKey),
    onArchiveSession: (sessionId) => void archiveSession(sessionId),
  });

  // Whether the open session is archived (D-094): a deep link or an archive-while-open can land the
  // browser on an archived session; the main UI then gates sending behind an explicit unarchive.
  const archived = readModel.archived;
  // A short, friendly name for the header strip (D-093): the first user prompt, one line and capped,
  // falling back to the session id before anything has been said.
  const sessionName = useMemo(() => selectSessionName(readModel, target), [readModel, target]);
  // Web stall guard: a turn left in flight by a host that crashed/restarted mid-turn (or a socket
  // flap that dropped the terminal event) with nothing rejoining to finish it would spin "Working"
  // forever. When no leader host is connected to ever close it, the browser closes it itself - the
  // client-side mirror of the host's reap-on-reconnect. Gated on a live, replayed view so it never
  // acts on a partial log; the per-runId ref makes it fire exactly once per orphaned turn.
  const orphanedTurn = useMemo(
    () =>
      detectOrphanedTurn(events, {
        leaderPresent: host.leaderId !== null,
        connected: status === "open" && replayed,
        now,
        graceMs: ORPHAN_GRACE_MS,
      }),
    [events, host.leaderId, status, replayed, now],
  );
  // A prompt left trailing on a session with NO host connected gets no `assistant.started`, so the busy
  // derivation would spin "Working" forever even though nothing is running (02.14). Disjoint from
  // `orphanedTurn` (which owns started-but-uncompleted runs): this fires only when no run started at all.
  // When it fires we drop the "Working" row - the no-host status line already tells the user to start a
  // host (which then runs the queued prompt via catch-up). It is presentation only; it never publishes.
  const hostlessPending = useMemo(
    () =>
      selectHostlessPending(readModel, {
        leaderPresent: host.leaderId !== null,
        connected: status === "open" && replayed,
        now,
        graceMs: ORPHAN_GRACE_MS,
      }),
    [readModel, host.leaderId, status, replayed, now],
  );
  // The ONE pinned live turn-status header (plan 50): the in-flight status line above the checklist,
  // undefined when no turn is active. `hostlessPending` suppresses it for a prompt stranded with no
  // host (the no-host status line carries that affordance instead), matching the retired working row's
  // gate; it composes elapsed/output-tokens/engine-state from events entirely web-side.
  const turnStatusHeader = useMemo(
    () => selectTurnStatusHeader(readModel, { hostlessPending }),
    [readModel, hostlessPending],
  );
  const reconciledRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (orphanedTurn && reconciledRunRef.current !== orphanedTurn.runId) {
      const { runId } = orphanedTurn;
      reconciledRunRef.current = runId;
      reconcileTurn(runId).catch(() => {
        // The recovery publish failed (transient transport error); drop the latch so the next clock
        // tick re-evaluates and retries, rather than leaving the spinner stuck behind a one-shot guard.
        if (reconciledRunRef.current === runId) {
          reconciledRunRef.current = null;
        }
      });
    }
  }, [orphanedTurn, reconcileTurn]);
  // Web stall guard for background SUBAGENTS (plan 52): a background child OUTLIVES its spawning turn, so
  // its terminal `delegated.to` can be lost independently of the turn reconcile if its owning host dies
  // before folding back - leaving the child stuck "running" forever. Same conservative gate as the turn
  // path (no leader + live replayed view + silent past grace); the browser closes each orphaned child to
  // `interrupted`, mirroring the host's `reapOrphanSubagents`. The Set ref fires the reconcile at most
  // once per childSessionId, and the host reap is idempotent by the same key, so a race converges on one card.
  const orphanedSubagents = useMemo(
    () =>
      detectOrphanedSubagents(events, {
        leaderPresent: host.leaderId !== null,
        connected: status === "open" && replayed,
        now,
        graceMs: ORPHAN_GRACE_MS,
      }),
    [events, host.leaderId, status, replayed, now],
  );
  const reconciledSubagentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const orphan of unreconciledSubagents(orphanedSubagents, reconciledSubagentRef.current)) {
      const { childSessionId } = orphan;
      reconciledSubagentRef.current.add(childSessionId);
      reconcileSubagent(orphan).catch(() => {
        // Transient publish failure: drop the latch so the next clock tick retries this child.
        reconciledSubagentRef.current.delete(childSessionId);
      });
    }
  }, [orphanedSubagents, reconcileSubagent]);
  // True while a manual /compact fold is streaming (a transient bar in the transcript). ESC cancels
  // it (manual folds are interruptible; automatic ones run to completion).
  const compacting = useMemo(() => transcript.some((m) => m.kind === "compacting"), [transcript]);

  // The agent's live task checklist (host-published snapshots), rendered in the header.
  const tasks = readModel.tasks;
  // Stale = the model hasn't touched the checklist since the user's last message (it may have moved on
  // to a new topic); drives the panel's "stale" badge + dismiss nudge (09.1).
  const staleTasks = readModel.staleTasks;
  // The support panel's background work (plan 09): promoted jobs the host announces live, and the
  // running subagent delegations from the transcript. Both derived from the live session, never cached.
  // One scan over the events feeds both the panel rows and the job-detail lookup below.
  // Pass the host-liveness verdict (the live leader id) so a dead host's `running` jobs render as
  // interrupted rather than a stuck "running" (plan 52 / D-003) - the derive-layer job reconcile.
  const jobs = useMemo(() => jobsFrom(announcement, host.leaderId), [announcement, host.leaderId]);
  const subagents = useMemo(() => runningSubagents(transcript), [transcript]);
  // The pending ask_user question (M5): projected from the log, it takes over the composer until answered.
  const pendingQuestion = readModel.pendingQuestion;
  // The pending generated handoff (02.10): a `/handoff` draft awaiting approve/edit/reject. Like a
  // question, it takes over the composer until resolved.
  const pendingHandoff = readModel.pendingHandoff;
  const loopInventoryRows = useLoopInventory(events);

  // The SidePanel's whole view-model in one pure selector: live-vs-completed precedence
  // for the Request data (ctx meter + treemap) and the per-category context aggregation,
  // folded from the transcript (+ raw events for the live snapshot). Spread into
  // <SidePanel> below. host depends on `now`; this only on transcript/events.
  const panel = readModel.panel;
  // Immediate host commands the host announced, plus the set of names used to tell a
  // command from an ordinary prompt at submit time.
  const commands = readModel.commands;
  // The host-owned Vim prompt preference (plan 06): gates the composer + full-surface editor Vim layer.
  const vimEnabled = readModel.vimEnabled;
  const commandSpecs = useMemo(() => {
    const announced = new Set(commands.map((c) => c.name));
    return [...BUILT_IN_COMMANDS.filter((c) => !announced.has(c.name)), ...commands];
  }, [commands]);
  const commandNames = useMemo(() => new Set(commandSpecs.map((c) => c.name)), [commandSpecs]);
  // The autocomplete menu shows everything EXCEPT hidden commands (e.g. /debug); they stay typeable
  // because `commandNames` (the parseCommand allow-set) is built from the full `commandSpecs`.
  const menuSpecs = useMemo(
    () => commandSpecs.filter((c) => !HIDDEN_COMMANDS.has(c.name)),
    [commandSpecs],
  );
  const slashMenu = useSlashMenu({ draft, commandSpecs: menuSpecs, inputRef, setDraft });
  // The composer caret, mirrored up from PromptInput (onCaretChange), so the `@`-file-mention menu can
  // detect the active token under the cursor. Only this feature needs it; the slash lane is caret-free.
  const [composerCaret, setComposerCaret] = useState(0);
  // The `@`-file-mention search (plan 30, D-004): the host answers ONE index request per session; the
  // browser fuzzy-filters that cached index LOCALLY per keystroke. Suppressed on `/loop` lines (D-003)
  // so at most one composer overlay owns a given line.
  const onLoopLine = loopPreviewForLine(draft, composerCaret) !== null;
  const activeMentionQuery = onLoopLine
    ? null
    : (activeMention(draft, composerCaret)?.query ?? null);
  // useFileIndex (not fileIndexFrom + useMemo keyed on `events`): `events`' array identity changes on
  // EVERY incoming session event, not just a file.index.result, which would otherwise re-derive a
  // fresh index object on each one and bust useWorkspaceFileSearch's memo below independently of its
  // own debounce (see the useFileIndex doc comment).
  const fileIndex = useFileIndex(events);
  const fileSearch = useWorkspaceFileSearch(activeMentionQuery, fileIndex);
  const fileMenu = useFileMentionMenu({
    draft,
    caret: composerCaret,
    results: fileSearch.results,
    truncated: fileSearch.truncated,
    suppressed: onLoopLine,
    inputRef,
    setDraft,
    setCaret: setComposerCaret,
  });
  // Ask the leader for the workspace index the first time `@` is used in this session (and once a
  // leader is present); the browser caches the reply and filters it locally. `crypto.randomUUID` ids
  // the request so a later refresh's result supersedes it (see fileIndexFrom). The decision (fresh
  // session, or a leader failover while still not ready - a lost request must not wedge the picker in
  // "loading" forever) is the pure, unit-tested `shouldRequestFileIndex`; this effect only acts on it.
  const fileIndexAskedRef = useRef<FileIndexAsked | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: requestFileIndex is a stable action.
  useEffect(() => {
    if (host.leaderId === null || sessionId === null) {
      return;
    }
    const leaderId = host.leaderId;
    if (
      !shouldRequestFileIndex({
        activeMentionQuery,
        ready: fileIndex.ready,
        leaderId,
        sessionId,
        askedFor: fileIndexAskedRef.current,
      })
    ) {
      return;
    }
    fileIndexAskedRef.current = { sessionId, leaderId };
    void requestFileIndex(crypto.randomUUID());
  }, [activeMentionQuery, fileIndex.ready, host.leaderId, sessionId]);
  // Focus the composer on load, once the session resolves and the input is enabled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref (from useComposer).
  useEffect(() => {
    if (sessionId) {
      inputRef.current?.focus();
    }
  }, [sessionId]);
  // Whether a pending ask_user question owns the surface right now. The window-focus handler below
  // runs from a mount-only effect, so it reads this ref to yield focus to the question instead of the
  // composer while a question is up (the composer is unmounted then anyway; this makes the policy
  // explicit and the QuestionSurface restores its own focus). <!-- D-002 -->
  const pendingQuestionRef = useRef(false);
  pendingQuestionRef.current = pendingQuestion !== null;
  // Refocus the composer whenever the tab/window regains focus - unless a pending question owns focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref (from useComposer).
  useEffect(() => {
    const focusInput = () => {
      if (pendingQuestionRef.current) {
        return;
      }
      inputRef.current?.focus();
    };
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
      if (isEditableTarget(event.target as Element | null)) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Durable follow-up queue (plan 47): a prompt submitted while a turn runs is PUBLISHED to the log
  // immediately and the HOST owns scheduling (it drains the backlog in order), so the browser no longer
  // withholds/drip-feeds. `queue` is projected from the log (each id = the durable eventId a supersede
  // names); submit publishes, the Escape-fold + unqueue + recall-pull all emit durable supersedes.
  const { queue, submit, flushQueuedSteer, unqueue, pullNewest } = useSendQueue({
    events,
    selfProducerId: PRODUCER_IDS.host,
    publish,
    supersede,
  });
  const visibleQueue = queue;

  const showThinkingOn = showThinking ?? true;
  const {
    activeProvider,
    reasoning,
    setReasoning,
    selection,
    sendModel,
    activeLabel,
    activeReasoningLevels,
    activeReasoning,
    sendModelRef,
    onSelectModel: selectActiveModel,
  } = useActiveModel({
    hostModels,
    hostSources,
    hostCatalog,
    hostModelPrefs,
    provider,
    setProvider,
    reasoningMap,
    setReasoningMap,
    hostDefault,
    lastUserModel,
    sessionId,
    activeRunId: active,
    switchModel,
  });
  const [chooserOpen, setChooserOpen] = useState(false);
  // Tangents (plan 37): a tangent is an isolated side conversation branched from a selected snapshot,
  // shown in the center-column takeover. `tangent` owns its lifecycle; discovery lists this session's
  // tangents. Both close the other center takeovers when opened (only one at a time).
  const tangent = useTangent();
  const [tangentDiscoveryOpen, setTangentDiscoveryOpen] = useState(false);
  // The tool detail takeover (plan 08): the id of the transcript row being inspected, or null when
  // closed. We hold the ID, not a snapshot, so the detail model is RE-DERIVED from the live transcript
  // each render (M6) - a running tool's detail updates in place through completion/error/abort, and the
  // takeover closes itself if its source row ever leaves the transcript (e.g. /clear).
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = useMemo(() => findDetailModel(transcript, detailId), [detailId, transcript]);
  // The inline-agent detail takeover (plan 09.4 M6): hold the delegated CHILD session id, and resolve
  // its agent name LIVE from the transcript's inline-agent block (like `detail` above) so the header
  // stays correct and a `/clear` that drops the row can close the takeover.
  const [agentDetailChild, setAgentDetailChild] = useState<string | null>(null);
  const agentDetailName = useMemo(() => {
    if (agentDetailChild === null) {
      return undefined;
    }
    for (const message of transcript) {
      if (message.kind === "inlineAgent") {
        const entry = message.agents.find((a) => a.childSessionId === agentDetailChild);
        if (entry) {
          return entry.agent;
        }
      }
    }
    return undefined;
  }, [transcript, agentDetailChild]);
  // If the backing inline-agent row leaves the parent transcript (e.g. /clear resets the log), close
  // the takeover - matching how the tool-detail takeover self-closes when its source row is gone.
  useEffect(() => {
    if (agentDetailChild !== null && agentDetailName === undefined) {
      setAgentDetailChild(null);
    }
  }, [agentDetailChild, agentDetailName]);
  // A promoted background job's detail takeover (plan 09 M8): hold the job id and re-derive its detail
  // model from the live job snapshots, so the takeover updates as the host re-announces (run -> exit).
  const [jobDetailId, setJobDetailId] = useState<string | null>(null);
  const jobDetailJob = useMemo(() => {
    if (jobDetailId === null) {
      return null;
    }
    return jobs.find((j) => j.id === jobDetailId) ?? null;
  }, [jobDetailId, jobs]);
  const jobDetail = useMemo(
    () => (jobDetailJob ? jobToDetailModel(jobDetailJob) : null),
    [jobDetailJob],
  );
  useEffect(() => {
    if (jobDetailId !== null && jobDetailJob === null) {
      setJobDetailId(null);
    }
  }, [jobDetailId, jobDetailJob]);
  // The full-surface prompt editor (02.12): a takeover for editing long prompts with room. The composer
  // expand button opens the current draft here; 02.10's generated-handoff edit opens it programmatically.
  const editor = usePromptEditor();
  // The archive browser's live actions (plan 04): unarchive reuses the existing `session.archived`
  // publish; permanent delete calls the store's purge. On success each refreshes the inventory so the
  // settled row drops on its own; a rejection/error latches a row-scoped message.
  const archiveActions = useArchiveActions({
    unarchive: (id) => archiveSession(id, false),
    remove: permanentlyDeleteSession,
    refresh: () => modal.inventory.refetch(),
  });
  const onSelectModel = (ref: ModelRef) => {
    selectActiveModel(ref);
    setChooserOpen(false);
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
    // `/new` is a browser-side UI command (plan 58 M4): it creates a fresh project-scoped session.
    // With a path arg (`/new ~/dev/foo`) it launches a fresh session for that project. With no arg
    // it uses the current session's known root, or falls back to the New-session picker when no root
    // is resolvable. Like `/resume` it is intercepted before the host command lane.
    if (isNewSessionCommand(text)) {
      const arg = text.slice(NEW_SESSION_COMMAND.name.length).trim();
      history.resetNavigation();
      setDraft("");
      if (arg) {
        startFreshProjectSession(arg);
      } else if (knownRoot !== null) {
        startFreshProjectSession(knownRoot);
      } else {
        openNewSession();
      }
      return;
    }
    // `/cd <path>` is a browser-side alias for `/new <path>` (plan 58 M4): same fresh project-scoped
    // session launch. Intercepted before the host command lane, never a model turn.
    if (text === "/cd" || text.startsWith("/cd ")) {
      const arg = text.slice("/cd".length).trim();
      history.resetNavigation();
      setDraft("");
      if (arg) {
        startFreshProjectSession(arg);
      } else if (knownRoot !== null) {
        startFreshProjectSession(knownRoot);
      } else {
        openNewSession();
      }
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
      text,
      provider: activeProvider,
      reasoning: reasoning || undefined,
      model: sendModelRef,
      artifacts,
      // The exact pasted payloads ride with the prompt so the host expands each `[Pasted text #N]`
      // token back to its full content at projection time.
      pastes: pastes.length ? pastes : undefined,
    });
    // Re-pin to the bottom on submit, even if scrolled up: the follow effect then snaps to each
    // new item (the prompt when its event round-trips, then the streaming answer) and holds there.
    scroll.pinToBottom();
  };

  const onLoopControl = (loopId: string, controlVerb: LoopControl) => {
    void command("/loop", `${controlVerb} ${loopId}`);
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
    // The `@`-file-mention menu owns its keys (arrows/Tab/Enter/Escape) next, before Enter-submit and
    // Up/Down history recall, so navigating/selecting a mention never submits or recalls a prompt.
    // Composer-owned atomic token deletion (Backspace/Delete) already ran in PromptInput; the mention
    // menu yields those keys, so image-token deletion is unaffected.
    if (fileMenu.onMenuKeyDown(event)) {
      return;
    }

    const el = event.currentTarget;
    // Menu closed: in a textarea Enter inserts a newline, so submit explicitly. Plain Enter sends and
    // the registry `Mod+Enter` chord sends (the explicit, documented send); Shift+Enter keeps the
    // newline (for multi-line prompts and quoted blocks). Validity is enforced by onSubmit.
    if (isComposerSubmitKey(event)) {
      event.preventDefault();
      el.form?.requestSubmit();
      return;
    }
    // Prompt history recall (D-084). ArrowUp recalls the previous prompt from the first line (or an
    // empty composer); ArrowDown steps forward while navigating, from the last line. Off the first/
    // last line, multi-line editing keeps normal caret movement (no preventDefault).
    const caret = el.selectionStart ?? 0;
    if (event.key === "ArrowUp" && caretOnFirstLine(el.value, caret)) {
      // Plan 47 M7: at an EMPTY composer, Up first pulls the NEWEST durable-queued follow-up back for
      // editing - an immediate supersede-removal (so there is no edit-vs-run race), pushed onto the
      // recall ring so re-submitting re-enqueues it. With text already typed, or an empty queue, Up falls
      // through to ordinary prompt-history recall; Up never hijacks the caret off the first line.
      if (draft === "" && queue.length > 0) {
        const pulled = pullNewest();
        if (pulled) {
          event.preventDefault();
          history.record(pulled.text);
          recallInto(el, pulled.text);
          return;
        }
      }
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

  // Steer meta: the active selection (provider/reasoning/model) stamped onto a folded prompt.
  const steerMeta = () => ({
    id: crypto.randomUUID(),
    provider: activeProvider,
    reasoning: reasoning || undefined,
    model: sendModelRef,
  });

  // Steer (Escape with queued prompts): fold the queue into ONE steering prompt, cancel the active
  // turn as `steered` (so the transcript shows a muted note, not the alarming red "cancelled"), and
  // publish the folded prompt so it runs next. All in one action - no two-step latch, no second Esc.
  // A plain cancel (no queued prompts) keeps the red "cancelled": it means "stop", not "redirect".
  const onFlushQueuedSteer = () => {
    flushQueuedSteer(steerMeta());
    const runId = active ?? (awaitingResponse ? "" : null);
    if (runId !== null) {
      void cancel(runId, true);
    } else if (compacting) {
      void cancel("", true);
    }
    inputRef.current?.focus();
  };

  // Explicit cancel (Escape with no queued prompts to steer, Mod+., or the Stop control): abort the
  // active turn / awaiting turn / manual fold. A typed draft is published as the next durable follow-up
  // (it runs in order after the cancel, keeping its image/document attachments), rather than folding the
  // already-durable queue - plan 47 runs queued follow-ups as distinct ordered turns, not a collapse.
  const onCancel = () => {
    const runId = active ?? (awaitingResponse ? "" : null);
    const text = draft.trim();
    const all = [...imageRefs, ...attachments];
    if (text || all.length > 0) {
      submit({
        text,
        provider: activeProvider,
        reasoning: reasoning || undefined,
        model: sendModelRef,
        artifacts: all.length ? all : undefined,
        pastes: pastes.length ? pastes : undefined,
      });
    }
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

  // The deliberate stop path (plan 07 M8): Mod+. and the palette "Stop" command. A direct, non-Escape
  // stop that routes through the SAME onCancel (steer the draft, abort the run/fold), but ONLY while
  // work is in progress - idle it is a no-op, so it never clears a draft the way Escape does. Escape
  // stays the progressive path (queued-steer first, then cancel); Mod+. is the immediate stop.
  const onStop = () => {
    if (busy || compacting) {
      onCancel();
    }
  };

  // ESC mirrors the cancel button when a run is active/pending; with nothing to
  // cancel it just clears the composer. One window listener reads the latest state
  // from a ref so it never goes stale and works regardless of which element has focus.
  // A modal/picker/takeover (model chooser, resume, worktree switcher) owns Escape while open -
  // it closes itself, and the turn on the transcript behind it must NOT be cancelled.
  // Every frontmost surface EXCEPT the tangent takeover. Split out so the tangent can tell whether it is
  // the SOLE frontmost surface (owns Escape) vs sitting behind a palette/modal (which then owns Escape).
  const otherTakeoverOpen =
    chooserOpen ||
    modal.resumeOpen ||
    modal.worktreeOpen ||
    modal.archiveOpen ||
    editor.isOpen ||
    paletteOpen ||
    helpOpen ||
    detail !== null ||
    jobDetail !== null ||
    tangentDiscoveryOpen ||
    artifactPanel?.open === true;
  const modalOpen = otherTakeoverOpen || tangent.active !== null;
  // The tangent owns Escape only when nothing is layered above it, so a higher overlay's Escape still wins.
  const tangentOwnsEscape = tangent.active !== null && !otherTakeoverOpen;

  // App actions shared by their keyboard shortcut (the router below) and their palette command, so the
  // two surfaces can never drift (plan 07 M7/M8).
  const toggleSidebar = () => modal.setSidebarOpen((open) => !open);
  const togglePanel = () => modal.setPanelOpen((open) => !open);
  const openHelp = () => setHelpOpen(true);

  // The command palette's data-driven commands (plan 07). The Vim toggle reads the live host preference
  // for its hint and dispatches the host `/vim` command (which persists + re-announces); the rest are
  // app actions that also have a keyboard shortcut, their label + chord read from the registry via
  // `shortcutCommand`. Cheap to build inline (and `onCancel` is a fresh closure each render, so a memo
  // would not hold anyway). The stop row is disabled, with its reason, exactly when `onStop` is a no-op.
  const paletteCommands: PaletteCommand[] = [
    vimToggleCommand(vimEnabled, command),
    shortcutCommand("toggle-sidebar", toggleSidebar),
    shortcutCommand("toggle-panel", togglePanel),
    shortcutCommand(
      "stop",
      onStop,
      busy || compacting ? undefined : { disabledReason: "no active run" },
    ),
    shortcutCommand("shortcuts-help", openHelp),
  ];

  // The latest Escape inputs + handlers, read by the router's window listener so it never goes stale.
  // The ref is reassigned every render (below); the seed only types it, so it never carries stale state.
  const escRef = useRef<EscRefShape>(null as unknown as EscRefShape);
  escRef.current = {
    active,
    awaiting: awaitingResponse,
    compacting,
    draft,
    modalOpen,
    handoffPending: pendingHandoff !== null,
    // The durable queue length decides queued-steer vs cancel. The steer (fold + cancel + submit)
    // happens in one Esc now, so there is no two-step latch: a non-empty queue routes to steer,
    // an empty queue routes to cancel.
    queued: queue.length,
    setDraft,
    onCancel,
    onFlushQueuedSteer,
    onDismissHandoff: () => {
      if (pendingHandoff) {
        rejectHandoff(pendingHandoff.handoffId);
      }
    },
    resetHistory: history.resetNavigation,
  };
  // Escape's global precedence (dismiss-handoff / queued-steer / cancel / clear-draft), resolved by the
  // pure escapeAction and routed through the one shortcut router below. The Vim layer's stopPropagation
  // suppresses this before it fires (a first Escape enters normal mode); an open overlay owns Escape via
  // escapeAction's modalOpen guard.
  const onEscape = useCallback((event: KeyboardEvent) => {
    const s = escRef.current;
    const action = escapeAction({
      active: s.active,
      awaiting: s.awaiting,
      compacting: s.compacting,
      draft: s.draft,
      modalOpen: s.modalOpen,
      handoffPending: s.handoffPending,
      queued: s.queued,
    });
    if (action === "dismiss-handoff") {
      event.preventDefault();
      s.onDismissHandoff();
    } else if (action === "flush-queued-steer") {
      event.preventDefault();
      s.onFlushQueuedSteer();
    } else if (action === "cancel") {
      event.preventDefault();
      s.onCancel();
    } else if (action === "clear-draft") {
      event.preventDefault();
      s.setDraft("");
      s.resetHistory(); // clearing the composer ends any in-progress history navigation
    }
  }, []);
  // The one window listener owning every app key: Mod chords + global Escape. While any frontmost overlay
  // (incl. the palette) is open, the global Mod shortcuts are suppressed so a key never reaches a surface
  // behind it.
  useShortcutRouter({
    overlayOpen: modalOpen,
    handlers: {
      "command-palette": () => setPaletteOpen(true),
      "shortcuts-help": openHelp,
      "toggle-sidebar": toggleSidebar,
      "toggle-panel": togglePanel,
      stop: onStop,
    },
    onEscape,
  });

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
          // Only one takeover at a time: opening the chooser closes the archive browser.
          onOpenChooser: () => {
            modal.setArchiveOpen(false);
            setChooserOpen((open) => !open);
          },
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
        compact: {
          show: compact,
          onShowChange: setCompact,
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
      <BackToChat onBack={() => setChooserOpen(false)} />
      <ModelChooser
        className="min-h-0 flex-1"
        sources={selection.sources}
        catalogBySource={selection.catalogBySource}
        activeModel={sendModel}
        recentKeys={selection.recentKeys}
        pinnedKeys={selection.pinnedKeys}
        defaultKey={selection.defaultKey}
        onTogglePin={toggleModelFavorite}
        onSetDefault={setModelDefault}
        deviceCode={signInDeviceCode}
        deviceCodeSourceId={signIn?.sourceId}
        signInStarting={signInStarting}
        onSubmitCode={(code) => void submitSignInCode(code)}
        onSelectModel={onSelectModel}
        onSourceAction={(id, action) => {
          // The single source-action dispatch (53 D-003): every action maps to a defined effect, so
          // none silently no-ops the way `configure` used to (there was no branch, so the button was
          // dead on every machine).
          const command = sourceActionCommand(action);
          switch (command.kind) {
            case "refresh-catalog":
              // Re-query each configured source's live /models.
              void refreshCatalog();
              return;
            case "sign-in":
              // The host-owned OAuth device-code / browser+paste sign-in (D-065 M5).
              void signInSource(id);
              return;
            case "show-setup-guidance":
              // configure has no host round-trip: the key lives in the host store and the source's
              // SourceAuthPanel already renders the setup guidance (the Anthropic Direct API and the
              // other api-key sources show the ~/.pi/auth.json key copy). Keep that guidance surface
              // open - never a paste form. (The Claude subscription is oauth now, so it signs in.)
              setChooserOpen(true);
              return;
            case "disable":
              // No source offers `disable` yet; the exhaustive command mapping keeps it from silently
              // dropping if one ever does.
              setChooserOpen(true);
              return;
          }
        }}
      />
    </div>
  ) : undefined;

  // The archive browser (plan 04): another takeover of the transcript/composer space (the sidebars stay
  // visible), opened from the sidebar footer. It lists the archived sessions and runs unarchive +
  // permanent-delete against the live mutations; row-scoped action state keeps one row's feedback from
  // blanking the rest. Rendered only while open. Its own back arrow returns to chat.
  const archiveRows = useMemo(
    () => buildArchiveRows(modal.inventory.sessions),
    [modal.inventory.sessions],
  );
  const archiveBrowser = modal.archiveOpen ? (
    <ArchiveBrowser
      className="h-full"
      rows={archiveRows}
      loading={modal.inventory.loading}
      error={modal.inventory.error}
      nowMs={now}
      actionState={archiveActions.actionState}
      onUnarchive={archiveActions.onUnarchive}
      onDelete={archiveActions.onDelete}
      onBack={() => {
        modal.setArchiveOpen(false);
        setArchiveProjectFilter(null);
      }}
      projectFilter={archiveProjectFilter}
      onClearProjectFilter={() => setArchiveProjectFilter(null)}
    />
  ) : undefined;

  // The tool detail takeover (plan 08): open it from a transcript row's inspect affordance, closing any
  // other center-column takeover first (only one at a time). The model is derived LIVE below, so a
  // running tool keeps updating while open.
  const onOpenDetail = (message: Message) => {
    if (!isDetailEligible(message)) {
      return;
    }
    setChooserOpen(false);
    modal.setArchiveOpen(false);
    setJobDetailId(null);
    setAgentDetailChild(null);
    setDetailId(message.id);
  };
  // A promoted job's detail (plan 09 M8): the SAME tool-detail takeover, opened from a support-panel job
  // row. Stop a running job via the host /jobs-stop command; the row + detail update on the re-announce.
  const onOpenJobDetail = (jobId: string) => {
    setChooserOpen(false);
    modal.setArchiveOpen(false);
    setDetailId(null);
    setAgentDetailChild(null);
    setJobDetailId(jobId);
  };
  // Open the inline-agent detail takeover from a row click (plan 09.4 M6), closing any other center
  // takeover first (only one at a time), mirroring onOpenDetail.
  const onOpenAgent = (childSessionId: string) => {
    setChooserOpen(false);
    modal.setArchiveOpen(false);
    setDetailId(null);
    setJobDetailId(null);
    setAgentDetailChild(childSessionId);
  };
  const closeAgentDetail = () => setAgentDetailChild(null);
  const onKillJob = (jobId: string) => void command("/jobs-stop", jobId);
  const onDismissJob = (jobId: string) => {
    void command("/jobs-dismiss", jobId);
    if (jobDetailId === jobId) {
      setJobDetailId(null);
    }
  };
  const closeJobDetail = () => setJobDetailId(null);
  const closeDetail = () => {
    const sourceId = detailId;
    setDetailId(null);
    if (sourceId) {
      // Best-effort: bring the source row back into view where the DOM still has it (the takeover
      // unmounts this frame, so defer to the next so the transcript is laid out again first).
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(sourceId)}"]`,
        );
        row?.scrollIntoView({ block: "center" });
      });
    }
  };
  const detailView =
    detail !== null ? (
      <ToolDetailView
        model={detail}
        onBack={closeDetail}
        onOpenPath={(path) => void openInEditor(path)}
        className="h-full"
      />
    ) : undefined;
  const jobDetailView =
    jobDetail !== null ? (
      <ToolDetailView
        model={jobDetail}
        onBack={closeJobDetail}
        action={
          jobDetailJob === null || !jobDismissEligible(jobDetailJob)
            ? undefined
            : { label: "Dismiss job", onClick: () => onDismissJob(jobDetail.id) }
        }
        className="h-full"
      />
    ) : undefined;
  const agentDetailView =
    agentDetailChild !== null ? (
      <LiveAgentDetail
        childSessionId={agentDetailChild}
        {...(agentDetailName !== undefined ? { agent: agentDetailName } : {})}
        onBack={closeAgentDetail}
        onOpenPath={(path) => void openInEditor(path)}
      />
    ) : undefined;

  // Tangents (plan 37). Opening a tangent (from a selection) or the discovery list closes any other
  // center takeover first - only one owns the center column at a time.
  const closeOtherTakeovers = () => {
    setChooserOpen(false);
    modal.setArchiveOpen(false);
    setDetailId(null);
    setJobDetailId(null);
    setAgentDetailChild(null);
  };
  const openTangent = (selection: TangentSelection) => {
    closeOtherTakeovers();
    setTangentDiscoveryOpen(false);
    tangent.open(selection, target);
  };
  const openTangentDiscovery = () => {
    closeOtherTakeovers();
    tangent.close();
    setTangentDiscoveryOpen(true);
  };
  // Explicit fold-back (M8): place the chosen tangent content into THIS (parent) composer for review via
  // the same quote-into-composer path, and record the durable marker on the tangent. It never auto-submits
  // and never injects hidden parent context - the folded text is plainly visible, editable composer text.
  const foldBackToParent = async (active: ActiveTangent, content: FoldBackContent) => {
    composer.quoteSelection(content.text);
    if (active.tangentSessionId) {
      await recordTangentFoldBack(active.tangentSessionId, {
        parentSessionId: active.parentSessionId,
        mode: content.mode,
        preview: foldBackPreview(content.text),
      });
    }
  };
  const tangentTakeover = tangent.active ? (
    <LiveTangentShell
      active={tangent.active}
      error={tangent.error}
      parentLabel={sessionName}
      turnModel={{
        provider: activeProvider,
        reasoning: reasoning || undefined,
        model: sendModelRef,
      }}
      onBack={tangent.close}
      onFoldBack={foldBackToParent}
      escapeOwned={tangentOwnsEscape}
      vimEnabled={vimEnabled}
    />
  ) : undefined;
  const tangentDiscoveryView = tangentDiscoveryOpen ? (
    <TangentDiscovery
      className="h-full"
      tangents={tangentsOf(modal.inventory.sessions, target)}
      nowMs={now}
      onOpen={(summary) => {
        setTangentDiscoveryOpen(false);
        tangent.openExisting(summary);
      }}
      onBack={() => setTangentDiscoveryOpen(false)}
    />
  ) : undefined;

  // Quick DEBUG-COMMAND buttons (trigger a /debug-mode command without typing it), plus the archived +
  // worktree affordances and the session id for orientation. `restart` is a temporary debug surface.
  const panelFooter = (
    <>
      {/* TEMP dev affordance (remove later): restart the host to pick up code changes. The typed
          `/restart` is debug-gated, but this explicit button sends `force` so a click restarts
          straight away regardless of debug mode (the click is its own confirmation). */}
      <button
        type="button"
        onClick={() => void command("/restart", "force")}
        title="Restart the host with fresh code"
        aria-label="Restart the host"
        className="flex cursor-pointer items-center gap-1 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-muted-foreground hover:text-foreground"
      >
        <RotateCcw className="size-3" />
        restart
      </button>
      <button
        type="button"
        onClick={() => {
          setChooserOpen(false); // only one takeover at a time
          setArchiveProjectFilter(null); // the footer entry shows ALL archived sessions
          modal.setArchiveOpen(true);
        }}
        title="Manage archived sessions"
        aria-label="Manage archived sessions"
        className="flex cursor-pointer items-center gap-1 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-muted-foreground hover:text-foreground"
      >
        <Archive className="size-3" />
        archived
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
      <button
        type="button"
        onClick={openTangentDiscovery}
        title="Tangents branched from this session"
        aria-label="Tangents from this session"
        className="flex cursor-pointer items-center gap-1 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-muted-foreground hover:text-foreground"
      >
        <GitBranch className="size-3" />
        tangents
      </button>
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
        // No live host: the 44.3 recovery affordances. A launch in flight reads "restarting host…" when
        // a host was here before (a stale/dead host - `announcement !== null`) and "starting host…" for
        // a never-hosted session; a failed launch shows the error + Retry; an idle no-host session with a
        // resolvable root offers "Start host"; with no resolvable root it keeps the shell-command hint.
        <HostLaunchStatus
          state={
            sessionLaunch.launchState === "starting"
              ? { phase: "starting", restarting: announcement !== null }
              : sessionLaunch.launchState === "failed"
                ? {
                    phase: "failed",
                    error: sessionLaunch.error ?? "The host could not be started.",
                    onRetry: sessionLaunch.retry,
                  }
                : knownRoot !== null
                  ? { phase: "startable", onStart: onStartHost, error: sessionLaunch.error }
                  : { phase: "hint", command: hostCommand }
          }
        />
      )
    ) : null;

  return (
    <>
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
          commandPreview: slashMenu.preview,
          fileMenu: {
            open: fileMenu.menuOpen,
            matches: fileMenu.matches,
            index: fileMenu.menuIndex,
            query: fileMenu.query ?? "",
            truncated: fileMenu.truncated,
            loading: fileMenu.menuOpen && !fileIndex.ready,
            onPick: fileMenu.acceptFile,
          },
          caret: composerCaret,
          onCaretChange: setComposerCaret,
          disabled: !sessionId,
          placeholder: `message ${activeLabel}… (/ for commands, @ for files, ! for shell)`,
          onExpand: () => editor.open({ text: draft, onConfirm: setDraft }),
          vimEnabled,
        }}
        stream={stream}
        host={host}
        transcript={{
          transcript,
          toolBatches,
          rowConfig: {
            onOpenPath: (path) => void openInEditor(path),
            onOpenArtifact: (artifact) => {
              setChooserOpen(false);
              modal.setArchiveOpen(false);
              setDetailId(null);
              setJobDetailId(null);
              setArtifactPanel((state) =>
                openArtifactPanel(state ?? createArtifactPanelState(), { artifact }),
              );
            },
            onDoctorRefresh: () => void command("/doctor", "refresh"),
            onMenuAction: (cmd: string, args: string) => void command(cmd, args),
            onOpenDetail,
            onOpenAgent,
            showThinking: showThinkingOn,
            compact,
          },
          // The pinned live turn-status header (plan 50) replaces the scrolling "Working" row. It is
          // already suppressed for a host-stranded prompt (turnStatusHeaderFrom is gated on
          // `awaitingResponse && !hostlessPending`), so the no-host status line still carries that
          // affordance; `busy`/the send queue are unchanged, so follow-ups still queue and catch up.
          turnStatusHeader,
          queue: visibleQueue,
          onUnqueue: unqueue,
        }}
        scroll={scroll}
        tasks={tasks}
        loopInventory={{ rows: loopInventoryRows, onControl: onLoopControl }}
        tasksStale={staleTasks}
        subagents={subagents}
        jobs={jobs}
        onOpenJobDetail={onOpenJobDetail}
        onKillJob={onKillJob}
        onDismissJob={onDismissJob}
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
        artifactPanel={
          artifactPanel?.open
            ? {
                artifact: selectedPanelArtifact,
                lucid: selectedLucidWiring,
                layout: artifactPanel.preference.layout,
                width: artifactPanel.preference.width,
                onClose: () =>
                  setArtifactPanel((state) => {
                    requestAnimationFrame(() => inputRef.current?.focus());
                    return closeArtifactPanel(state ?? createArtifactPanelState());
                  }),
                onResetWidth: () =>
                  setArtifactPanel((state) =>
                    resetArtifactPanelPreference(state ?? createArtifactPanelState()),
                  ),
                onWidthChange: (width) =>
                  setArtifactPanel((state) =>
                    resizeArtifactPanel(state ?? createArtifactPanelState(), width),
                  ),
              }
            : undefined
        }
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
          groups: projectSidebar.groups,
          searchQuery: projectSidebar.searchQuery,
          onSearch: projectSidebar.onSearch,
          onToggleProject: projectSidebar.onToggleProject,
          // Same safe switch path as `/resume` (D-093 M4): navigateToSession syncs `?session=` and
          // resets the per-session draft/queue/history via the sessionId-keyed hooks. Switching is
          // ALWAYS allowed, even while a turn runs - the run keeps going on the host (its events stay in
          // the durable log and replay on return); the row's activity bar shows it from the other view.
          onSelect: navigateToSession,
          onShowMore: projectSidebar.onShowMore,
          onAddProject: projectSidebar.onAddProject,
          onNewSession: projectSidebar.onNewSession,
          onArchiveSession: projectSidebar.onArchiveSession,
          onRenameProject: projectSidebar.onRenameProject,
          onRemoveProject: projectSidebar.onRemoveProject,
          onViewArchive: (projectKey) => {
            setArchiveProjectFilter(projectKey);
            modal.setArchiveOpen(true);
          },
          currentSessionId: target,
          liveActivity: modal.sidebarLiveActivity,
          nowMs: now,
        }}
        sessionName={sessionName}
        onTangent={openTangent}
        chooser={
          editor.isOpen ? (
            <PromptSurfaceEditor
              text={editor.text}
              title={editor.title}
              onTextChange={editor.setText}
              onConfirm={editor.confirm}
              vimEnabled={vimEnabled}
            />
          ) : (
            (tangentTakeover ??
            tangentDiscoveryView ??
            jobDetailView ??
            detailView ??
            agentDetailView ??
            archiveBrowser ??
            chooser)
          )
        }
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
        handoff={{
          pending: pendingHandoff,
          onApprove: (handoffId) => void approveHandoff(handoffId),
          onReject: (handoffId) => void rejectHandoff(handoffId),
          onEdit: (handoffId, prompt) =>
            editor.open({
              text: prompt,
              title: "Edit handoff prompt",
              onConfirm: (edited) => void approveHandoff(handoffId, edited),
            }),
        }}
      />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={paletteCommands} />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <NewSessionPicker
        open={modal.newOpen}
        onOpenChange={modal.setNewOpen}
        recents={supervisor.recents}
        path={supervisor.path}
        validation={supervisor.validation}
        localPickerAvailable={localPickerAvailable}
        launchState={supervisor.launchState}
        error={supervisor.error}
        onPickRecent={supervisor.onPickRecent}
        onPickFolder={supervisor.onPickFolder}
        onPathChange={supervisor.onPathChange}
        onCreate={supervisor.onCreate}
        onRetry={supervisor.onRetry}
        nowMs={now}
      />
    </>
  );
}
