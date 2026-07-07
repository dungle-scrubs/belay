import type {
  ArtifactRef,
  CommandSpec,
  FileMatch,
  GitStatus,
  JobSnapshot,
  LoopControl,
  LoopInventoryRow,
  ProviderQuestionAnswer,
  SessionActivity,
  TaskSnapshot,
  WorktreeSummary,
} from "@trevor/session";
import { ChevronDown } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SubmitEvent,
  useMemo,
} from "react";
import { ArtifactPanel } from "@/artifact-panel/artifact-panel";
import type { ArtifactPanelLayout } from "@/artifact-panel/artifact-panel-state";
import type { LucidPanelWiring } from "@/artifact-panel/lucid/lucid-viewer";
import {
  QuoteSelectionToolbar,
  type TangentSelection,
} from "@/components/assistant-ui/quote-selection-toolbar";
import { ActionShimmer } from "@/components/chat/action-shimmer";
import { ArchivedNotice } from "@/components/chat/archived-notice";
import { activeOptionId } from "@/components/chat/autocomplete-menu";
import { CommandMenu, SLASH_MENU_LISTBOX_ID } from "@/components/chat/command-menu";
import { CommandPreview } from "@/components/chat/command-preview";
import { FILE_MENTION_LISTBOX_ID, FileMentionMenu } from "@/components/chat/file-mention-menu";
import { LoopInventory } from "@/components/chat/loop/loop-inventory";
import { PromptInput } from "@/components/chat/prompt-input";
import { QueuedPrompts } from "@/components/chat/queued-prompts";
import { TurnStatusHeader } from "@/components/chat/turn-status-header";
import { type TranscriptRowConfig, VirtualTranscript } from "@/components/chat/virtual-transcript";
import { RowChooserModal } from "@/components/command-modal";
import { HandoffApprovalSurface } from "@/components/handoff/handoff-approval-surface";
import { DrawerToggle } from "@/components/panel/side-drawer";
import { SidePanel, SidePanelBreakdown, SidePanelHeader } from "@/components/panel/side-panel";
import { QuestionSurface } from "@/components/question";
import type { CommandArgPreview } from "@/derive";
import type { Composer } from "@/hooks/use-composer";
import { cn } from "@/lib/utils";
import type { ScrollFollowController } from "@/scroll-follow";
import type { SessionStream } from "@/session/use-session";
import { ProjectSidebar } from "@/sidebar/project-sidebar";
import type { ProjectGroup } from "@/sidebar/project-sidebar-model";
import type {
  HostStatus,
  PendingHandoff,
  PendingQuestion,
  TurnStatusHeaderData,
} from "../../derive";
import { type InventoryState, RESUME_CHOOSER, type ResumeContext } from "../../resume";
import type { QueuedPrompt } from "../../send-queue";
import type { SupportSubagent } from "../../support-panel/support-panel";
import { SupportPanel } from "../../support-panel/support-panel-view";
import type { PanelModel, readOnlyToolBatches, toTranscript } from "../../transcript";
import { buildTranscriptRows } from "../../transcript-rows";
import { WORKTREE_CHOOSER } from "../../worktrees";
import type { WorktreeRowsContext } from "../../worktrees/worktree-rows";

type Transcript = ReturnType<typeof toTranscript>;
type ToolBatches = ReturnType<typeof readOnlyToolBatches>;

/**
 * The transcript view-model: the coalesced messages plus the live-turn + queue state and the
 * read-only-batch grouping/handlers needed to render each row. Pure data + callbacks, no state.
 */
export interface TranscriptView {
  readonly transcript: Transcript;
  readonly toolBatches: ToolBatches;
  /** The per-row rendering config (row takeovers/commands + thinking/compact flags), forwarded as one
   *  bundle to VirtualTranscript rather than re-threaded field by field. */
  readonly rowConfig: TranscriptRowConfig;
  /** The pinned live turn-status header (plan 50): the one in-flight status line above the checklist,
   *  or undefined when no turn is active. Replaces the retired scrolling "Working" row. */
  readonly turnStatusHeader?: TurnStatusHeaderData;
  readonly queue: readonly QueuedPrompt[];
  /** Unqueue a durable follow-up (plan 47): supersede it so the host drops it from the run. */
  readonly onUnqueue: (id: string) => void;
}

/**
 * The transcript scroll wiring: the two refs (scroll container + content) plus the at-edge state
 * and the scroll handlers. Owned by App (the follow effects read these refs); PanelHost only binds
 * them to the DOM.
 */
export interface TranscriptScroll {
  readonly transcriptRef: RefObject<HTMLDivElement | null>;
  /** The follow authority (plan 12.2), threaded to VirtualTranscript so its writes ask the same
   *  controller the jump affordance reads. */
  readonly controller: ScrollFollowController;
  readonly atBottom: boolean;
  /** True when content appended below the fold while scrolled up (D-093): glows the chevron. */
  readonly hasUnseen: boolean;
  readonly bottomRequestId: number;
  readonly onScroll: () => void;
  /** A directional user gesture (wheel `deltaY` sign): upward unpins synchronously. */
  readonly onUserGesture: (direction: "up" | "down") => void;
  readonly scrollToBottom: () => void;
}

/**
 * The App-owned composer wiring (distinct from the `composer` hook's local state): submit + the
 * slash-menu interaction (open state, matches, highlight, accept) and the composer's enabled/label
 * descriptors. App owns these because they depend on the send queue, the host command list, and the
 * model; PanelHost just renders the menu + form against them.
 */
export interface ComposeWiring {
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  readonly onInputKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  readonly menuOpen: boolean;
  readonly menuMatches: readonly CommandSpec[];
  readonly menuIndex: number;
  readonly slashQuery: string | null;
  readonly acceptCommand: (name: string) => void;
  /** The live substitution preview for a file-loaded custom command (plan 44.5 M6), or null. Shown in
   *  the same overlay slot as the slash menu, but PAST the first space - so the two never co-occur. */
  readonly commandPreview: CommandArgPreview | null;
  /** The `@`-file-mention menu (plan 30): the sibling overlay of the slash menu, mutually exclusive
   *  with it per line. App owns the active-token detection + host search; PanelHost renders the list. */
  readonly fileMenu: {
    readonly open: boolean;
    readonly matches: readonly FileMatch[];
    readonly index: number;
    readonly query: string;
    readonly truncated: boolean;
    readonly loading: boolean;
    readonly onPick: (path: string) => void;
  };
  /**
   * The composer caret: a single source of truth OWNED by App (not duplicated as a second local state
   * inside PromptInput), since both PromptInput's own LoopHelper preview and App's `/loop`-line
   * suppression decision for the `@`-mention menu must always agree on the same value.
   */
  readonly caret: number;
  /** Report the composer caret up to App, so it can detect the active `@` token (mention menu). */
  readonly onCaretChange: (caret: number) => void;
  readonly disabled: boolean;
  readonly placeholder: string;
  /** Open the current draft in the full-surface prompt editor (02.12). */
  readonly onExpand: () => void;
  /** Whether the host-owned Vim prompt mode is enabled (plan 06); gates the composer's Vim layer. */
  readonly vimEnabled: boolean;
}

/**
 * The side panel's whole binding: the toggle (open + open/close) plus the header/footer slots and
 * the panel view-model. The model is the `panelModel(...)` selector's result, spread into SidePanel.
 */
export interface PanelBinding {
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly title: string;
  readonly subtitle: string;
  readonly statusNode: ReactNode;
  readonly workspace?: string;
  readonly git?: GitStatus | null;
  readonly model: PanelModel;
  readonly controls: ReactNode;
  readonly footer: ReactNode;
  readonly ready: boolean;
}

export interface ArtifactPanelBinding {
  readonly artifact: ArtifactRef | null;
  /** The Lucid review wiring (plan 27), present only when the open artifact is a Lucid surface. */
  readonly lucid?: LucidPanelWiring;
  readonly layout: ArtifactPanelLayout;
  readonly width: number;
  readonly onClose: () => void;
  readonly onResetWidth: () => void;
  readonly onWidthChange: (width: number) => void;
}

/**
 * The resume + worktree choosers (D-090/D-091): both browser-side UI affordances. App owns their
 * open state, the inventory fetch, and the switch/resume actions; PanelHost renders the modals and
 * the inline open buttons against this binding.
 */
export interface ChooserBinding {
  readonly resumeOpen: boolean;
  readonly setResumeOpen: (open: boolean) => void;
  readonly worktreeOpen: boolean;
  readonly setWorktreeOpen: (open: boolean) => void;
  readonly inventory: InventoryState;
  readonly resumeContext: ResumeContext;
  readonly onResume: (sessionId: string) => void;
  readonly worktrees: readonly WorktreeSummary[];
  readonly worktreeContext: WorktreeRowsContext;
  readonly onSwitchWorktree: (id: string) => void;
}

/**
 * The project sidebar binding (plan 58 M6): the left-hand project-first navigation rail. App owns
 * the open state, the project/session inventory, the live-activity overlay, and the project/session
 * actions; PanelHost renders the rail (when open) and the upper-left dashboard toggle (when closed).
 * The grouped read model + search/collapse/show-more state come from useProjectSidebar; this binding
 * adds the open toggle, the current session id (for row highlight), and the live-activity map.
 */
export interface SidebarBinding {
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  /** The grouped, filtered read model from useProjectSidebar. */
  readonly groups: readonly ProjectGroup[];
  /** The active search query (echoed into the search field). */
  readonly searchQuery: string;
  /** Set the search query. */
  readonly onSearch: (query: string) => void;
  /** Toggle a project's collapsed state (persists via the supervisor). */
  readonly onToggleProject: (key: string) => void;
  /** Select (navigate to) a session. */
  readonly onSelect: (sessionId: string) => void;
  /** Reveal more sessions under a project (past SESSION_CAP). */
  readonly onShowMore: (key: string) => void;
  /** Add a project (opens the OS folder picker via the supervisor). */
  readonly onAddProject: () => void;
  /** Launch a fresh project-scoped session (M4). */
  readonly onNewSession: (projectKey: string) => void;
  /** Archive a session from the sidebar. */
  readonly onArchiveSession: (sessionId: string) => void;
  /** Rename a project (persisted via the supervisor). */
  readonly onRenameProject: (key: string, name: string) => void;
  /** Remove a project (persisted via the supervisor; blocked by active sessions). */
  readonly onRemoveProject: (key: string) => void;
  /** View an archive-only project's archived sessions, filtered to that project (plan 58 M7). */
  readonly onViewArchive?: (projectKey: string) => void;
  /** The currently selected session id (for row highlight). */
  readonly currentSessionId: string;
  /** Live run state per session, layered over each row's durable activity. */
  readonly liveActivity: ReadonlyMap<string, SessionActivity>;
  readonly nowMs: number;
}

/**
 * PanelHost owns the rendered chat layout: the session sidebar, the main column (transcript well +
 * task checklist + composer), the toggleable side panel, and the resume/worktree choosers. It owns
 * NO state - it is
 * pure presentation over the injected view-models and wiring. App stays the composition root: it
 * wires the hooks (session, composer, send queue) and folds the memos (transcript, panelModel,
 * host), then hands them here as cohesive objects. The JSX is moved verbatim from app.tsx - same
 * DOM, classes, element order, conditionals, and keys.
 */
export function PanelHost(props: {
  composer: Composer;
  compose: ComposeWiring;
  stream: SessionStream;
  host: HostStatus;
  transcript: TranscriptView;
  scroll: TranscriptScroll;
  tasks: readonly TaskSnapshot[];
  loopInventory: {
    readonly rows: readonly LoopInventoryRow[];
    readonly onControl: (loopId: string, control: LoopControl) => void;
  };
  /** The checklist is stale (the user spoke after the model last touched it); drives the panel badge. */
  tasksStale?: boolean;
  /** Background subagents (running delegations) for the support panel (plan 09). */
  subagents?: readonly SupportSubagent[];
  /** Promoted background jobs for the support panel (plan 09). */
  jobs?: readonly JobSnapshot[];
  /** Open a promoted job's detail takeover (plan 09 M8). */
  onOpenJobDetail?: (jobId: string) => void;
  /** Stop a running promoted job (plan 09 M8). */
  onKillJob?: (jobId: string) => void;
  /** Dismiss a terminal promoted job from the host snapshot. */
  onDismissJob?: (jobId: string) => void;
  panel: PanelBinding;
  artifactPanel?: ArtifactPanelBinding;
  choosers: ChooserBinding;
  sidebar: SidebarBinding;
  /** A short name for the open session, shown in the main header strip (D-093). */
  sessionName: string;
  /** The full model chooser (D-065), rendered as a takeover of the transcript/composer center column
   *  while the sidebars stay visible. Undefined (the common case) when the chooser is closed. */
  chooser?: ReactNode;
  /** Open a tangent (plan 37) from a single-message selection in the transcript. Undefined leaves the
   *  toolbar's Tangent action disabled (the Storybook-only default). */
  onTangent?: (selection: TangentSelection) => void;
  /** Whether the open session is archived (D-094): gates the composer behind an unarchive notice. */
  archived: boolean;
  onUnarchive: () => void;
  /** The pending ask_user question (M5): when set, the QuestionSurface takes over the composer area. */
  question: {
    readonly pending: PendingQuestion | null;
    readonly onAnswer: (answer: ProviderQuestionAnswer) => void;
  };
  /** The pending generated handoff (02.10): when set, the approval surface takes over the composer area. */
  handoff: {
    readonly pending: PendingHandoff | null;
    readonly onApprove: (handoffId: string) => void;
    readonly onReject: (handoffId: string) => void;
    readonly onEdit: (handoffId: string, prompt: string) => void;
  };
}) {
  const {
    composer,
    compose,
    stream,
    host,
    transcript: tv,
    scroll,
    tasks,
    loopInventory,
    tasksStale,
    subagents,
    jobs,
    onOpenJobDetail,
    onKillJob,
    onDismissJob,
    panel,
    artifactPanel,
    choosers,
  } = props;
  const { sidebar, sessionName, chooser, archived, onUnarchive, question, handoff, onTangent } =
    props;
  const { replayed } = stream;
  const { transcript, toolBatches, rowConfig, queue, onUnqueue } = tv;
  const { turnStatusHeader } = tv;
  const rows = useMemo(
    () => buildTranscriptRows({ toolBatches, transcript }),
    [toolBatches, transcript],
  );
  // Every scroll event reaches the controller, even before the list reveals (`data-transcript-ready`
  // false). The controller recognizes its own settle-loop writes as self-writes, so they no longer need
  // to be dropped here to avoid a false unpin (plan 12.2); dropping them was one of the flick-reset causes.
  const onTranscriptScroll = () => {
    scroll.onScroll();
  };

  return (
    <div className="flex h-svh">
      {/* The project sidebar (plan 58 M6): a collapsible left rail listing all projects and
        their sessions. Switching routes through the same safe path as `/resume`. */}
      {sidebar.open ? (
        <ProjectSidebar
          groups={sidebar.groups}
          searchQuery={sidebar.searchQuery}
          onSearchChange={sidebar.onSearch}
          onToggleProject={sidebar.onToggleProject}
          onSelectSession={sidebar.onSelect}
          onShowMore={sidebar.onShowMore}
          onAddProject={sidebar.onAddProject}
          onNewSession={sidebar.onNewSession}
          onArchiveSession={sidebar.onArchiveSession}
          onRenameProject={sidebar.onRenameProject}
          onRemoveProject={sidebar.onRemoveProject}
          onViewArchive={sidebar.onViewArchive}
          liveActivity={sidebar.liveActivity}
          currentSessionId={sidebar.currentSessionId}
          nowMs={sidebar.nowMs}
          className="w-64 shrink-0"
        />
      ) : null}
      <main className="relative flex min-w-0 flex-1 flex-col bg-smui-surface-sunken px-4">
        {/* Highlight text in any message (data-message-id) to get a floating Quote action
          that drops the selection into the composer as a markdown blockquote. */}
        <QuoteSelectionToolbar onQuote={composer.quoteSelection} onTangent={onTangent} />
        {/* Thin top header (D-093): a dedicated strip for the two drawer-open toggles + the session
          name, so the toggles never sit over the transcript (they used to block text selection). The
          icons are revealed by hovering anywhere in this strip (group-hover), not just the icon. The
          left/right slots stay reserved so the centered name doesn't shift when a drawer opens. */}
        <header className="flex h-8 shrink-0 items-center gap-2">
          <span className="flex w-6 shrink-0 justify-start">
            {!sidebar.open ? (
              <DrawerToggle side="left" onClick={sidebar.onOpen} label="Open sessions sidebar" />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-center text-label tracking-wider text-muted-foreground/70">
            {sessionName}
          </span>
          <span className="flex w-6 shrink-0 justify-end">
            {!panel.open ? (
              <DrawerToggle side="right" onClick={panel.onOpen} label="Open panel" />
            ) : null}
          </span>
        </header>
        {/* The model chooser takeover (D-065): fills the transcript + composer space below the header
          while the left/right drawers stay visible. Rendered over the column (the transcript/composer
          stay mounted underneath, preserving scroll + draft) only while open. */}
        {chooser ? (
          <div className="absolute inset-x-4 top-8 bottom-0 z-20 flex flex-col overflow-hidden bg-smui-surface-sunken">
            {chooser}
          </div>
        ) : null}
        {/* Transcript fills the view; the composer + footer pin to the bottom. The scroll well carries a
          themed native scrollbar (index.css `[data-transcript-scroll]`, plan 33). The relative wrapper
          anchors the jump-to-bottom chevron over the transcript's lower edge. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scroll.transcriptRef}
            onScroll={onTranscriptScroll}
            onWheel={(event) => {
              // Extract the gesture DIRECTION from the wheel: an upward wheel unpins synchronously at
              // this event, before the DOM has even moved. A touch drag / scrollbar / keyboard scroll
              // has no wheel event and is caught by the controller's scroll-event catch-all instead.
              if (event.deltaY !== 0) {
                scroll.onUserGesture(event.deltaY < 0 ? "up" : "down");
              }
            }}
            data-transcript-scroll
            data-transcript-pinned={scroll.atBottom ? "true" : "false"}
            className="flex flex-1 flex-col overflow-y-auto py-4"
          >
            {/* Three states, so the page never looks broken while things come up:
              1. still replaying the session stream -> a brief "connecting to session" state;
              2. replayed + empty + no host joined yet (e.g. just opened via `trevor`, host booting)
                 -> a clear "waiting for host" state that vanishes once the host announces online;
              3. otherwise -> the full history (existing session pinned to bottom, empty at top), 150ms fade. */}
            {!replayed ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2">
                <ActionShimmer label="connecting to session" />
              </div>
            ) : !host.leaderId && transcript.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <ActionShimmer label={host.present ? "connecting to host" : "starting host"} />
                <span className="text-label tracking-wider text-muted-foreground/70">
                  waiting for the agent host to start and join this session…
                </span>
              </div>
            ) : (
              <VirtualTranscript
                rows={rows}
                scrollRef={scroll.transcriptRef}
                controller={scroll.controller}
                scrollToBottomRequest={scroll.bottomRequestId}
                rowConfig={rowConfig}
              />
            )}
          </div>
          {!scroll.atBottom ? (
            <button
              type="button"
              onClick={scroll.scrollToBottom}
              aria-label={scroll.hasUnseen ? "Scroll to new content" : "Scroll to bottom"}
              data-unseen={scroll.hasUnseen ? "true" : undefined}
              className={cn(
                "absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-md border bg-card shadow-sm transition-colors",
                // Two states: plain away-from-edge, or a primary-colored border/icon when there is
                // unseen content below (no glow shadow - the border color alone signals it).
                scroll.hasUnseen
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <ChevronDown className="size-4" />
            </button>
          ) : null}
        </div>

        {/* The ONE pinned live turn-status line (plan 50), above the checklist for the whole active
          turn - even when there are no task rows. The `esc to interrupt` hint that the retired
          scrolling working row carried lives here beside it (never inside the metrics parenthetical);
          the interrupt BEHAVIOR is the global Escape handler, unchanged. */}
        {turnStatusHeader ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pt-1 font-mono">
            <TurnStatusHeader {...turnStatusHeader} />
            <span className="text-label tracking-wider text-muted-foreground/50">
              esc to interrupt
            </span>
          </div>
        ) : null}

        {/* Live task checklist, above the composer. */}
        <SupportPanel
          tasks={tasks}
          subagents={subagents ?? []}
          jobs={jobs ?? []}
          stale={tasksStale}
          onOpenJobDetail={onOpenJobDetail}
          onKillJob={onKillJob}
          onDismissJob={onDismissJob}
        />

        {loopInventory.rows.length > 0 ? (
          <LoopInventory
            className="mb-2"
            rows={loopInventory.rows}
            onControl={loopInventory.onControl}
          />
        ) : null}

        <QueuedPrompts queue={queue} onUnqueue={onUnqueue} />

        {/* Pinned bottom: composer, then a two-column footer (status + model controls).
          Files dropped anywhere here upload as attachments. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: passive drop target; the
          keyboard-accessible path is the attach button below. */}
        <div
          onDrop={composer.onDrop}
          onDragOver={(event) => event.preventDefault()}
          className="relative shrink-0 pt-2 pb-4"
        >
          {/* Archived sessions (D-094) gate the composer: unarchive is required before normal use.
            The transcript history stays readable above; only sending is blocked. */}
          {archived ? (
            <ArchivedNotice onUnarchive={onUnarchive} />
          ) : question.pending ? (
            // A pending ask_user question takes over the composer until answered (M5). The draft stays
            // in tab-scoped state, so it is restored when the question resolves and the input returns.
            // Keyed by questionId so a new question gets a fresh draft and re-runs the mount focus
            // instead of inheriting the prior question's selections.
            <QuestionSurface
              key={question.pending.questionId}
              contract={question.pending.contract}
              onAnswer={question.onAnswer}
            />
          ) : handoff.pending ? (
            // A pending `/handoff` draft takes over the composer until approved/edited/rejected (02.10).
            // Keyed by handoffId so a fresh draft re-runs the mount focus.
            <HandoffApprovalSurface
              key={handoff.pending.handoffId}
              handoff={handoff.pending}
              onApprove={() => handoff.onApprove(handoff.pending?.handoffId ?? "")}
              onReject={() => handoff.onReject(handoff.pending?.handoffId ?? "")}
              onEdit={(prompt) => handoff.onEdit(handoff.pending?.handoffId ?? "", prompt)}
            />
          ) : (
            <>
              {/* Slash menu: overlays above the composer (absolute, so it never pushes the
                transcript up). Filters the host's announced command inventory as you type a
                leading "/", with the matched prefix highlighted. Arrows/Tab/Enter pick a row
                (handled on the input); a row click fills the composer. onMouseDown (not
                onClick) so the input keeps focus. */}
              {compose.menuOpen ? (
                <CommandMenu
                  className="absolute inset-x-0 bottom-full z-20 mb-2"
                  matches={compose.menuMatches}
                  activeIndex={compose.menuIndex}
                  query={compose.slashQuery ?? ""}
                  onPick={compose.acceptCommand}
                />
              ) : null}

              {/* The `@`-file-mention overlay (plan 30): the sibling of the slash menu, in the same
                bottom-full slot. Mutually exclusive with it per line, so both never show at once. */}
              {compose.fileMenu.open ? (
                <FileMentionMenu
                  className="absolute inset-x-0 bottom-full z-20 mb-2"
                  matches={compose.fileMenu.matches}
                  activeIndex={compose.fileMenu.index}
                  query={compose.fileMenu.query}
                  truncated={compose.fileMenu.truncated}
                  loading={compose.fileMenu.loading}
                  onPick={compose.fileMenu.onPick}
                />
              ) : null}

              {/* The live custom-command substitution preview (plan 44.5 M6): the same bottom-full slot,
                but PAST the first space (where both menus above have closed), so it never stacks. */}
              {compose.commandPreview && !compose.menuOpen && !compose.fileMenu.open ? (
                <CommandPreview
                  className="absolute inset-x-0 bottom-full z-20 mb-2"
                  preview={compose.commandPreview}
                />
              ) : null}

              <PromptInput
                composer={composer}
                onSubmit={compose.onSubmit}
                onKeyDown={compose.onInputKeyDown}
                caret={compose.caret}
                onCaretChange={compose.onCaretChange}
                disabled={compose.disabled}
                placeholder={compose.placeholder}
                onExpand={compose.onExpand}
                vimEnabled={compose.vimEnabled}
                // Either composer menu owning the keys suspends the Vim layer (arrows/Enter/Escape).
                menuOpen={compose.menuOpen || compose.fileMenu.open}
                // Point aria-activedescendant/aria-controls at whichever overlay is open (M5). The
                // slash menu's `menuOpen` already implies matches.length > 0 (useSlashMenu never opens
                // empty); the file-mention menu can be "open" with ZERO matches (loading / no-results -
                // useFileMentionMenu deliberately keeps Escape working then), so it needs an explicit
                // matches.length guard or these would point at a listbox/option id AutocompleteMenu
                // never renders in that state.
                menuListboxId={
                  compose.menuOpen
                    ? SLASH_MENU_LISTBOX_ID
                    : compose.fileMenu.open && compose.fileMenu.matches.length > 0
                      ? FILE_MENTION_LISTBOX_ID
                      : undefined
                }
                activeDescendantId={
                  compose.menuOpen
                    ? activeOptionId(SLASH_MENU_LISTBOX_ID, compose.menuIndex)
                    : compose.fileMenu.open && compose.fileMenu.matches.length > 0
                      ? activeOptionId(FILE_MENTION_LISTBOX_ID, compose.fileMenu.index)
                      : undefined
                }
              />
            </>
          )}
        </div>
      </main>

      {artifactPanel ? (
        <ArtifactPanel
          artifact={artifactPanel.artifact}
          lucid={artifactPanel.lucid}
          layout={artifactPanel.layout}
          width={artifactPanel.width}
          onClose={artifactPanel.onClose}
          onResetWidth={artifactPanel.onResetWidth}
          onWidthChange={artifactPanel.onWidthChange}
        />
      ) : null}

      {panel.open ? (
        <SidePanel
          ready={panel.ready}
          controls={panel.controls}
          footer={panel.footer}
          onClose={panel.onClose}
        >
          <SidePanelHeader
            title={panel.title}
            subtitle={panel.subtitle}
            statusNode={panel.statusNode}
            workspace={panel.workspace}
            git={panel.git}
            // Other managed worktrees for this project = switch targets beyond the current checkout.
            worktreeCount={choosers.worktrees.filter((w) => !w.current).length}
            onOpenWorktrees={() => choosers.setWorktreeOpen(true)}
          />
          <SidePanelBreakdown {...panel.model} ready={panel.ready} />
        </SidePanel>
      ) : null}

      <RowChooserModal
        adapter={RESUME_CHOOSER}
        open={choosers.resumeOpen}
        onOpenChange={choosers.setResumeOpen}
        data={choosers.inventory.sessions}
        loading={choosers.inventory.loading}
        error={choosers.inventory.error}
        context={choosers.resumeContext}
        onSelect={choosers.onResume}
      />

      <RowChooserModal
        adapter={WORKTREE_CHOOSER}
        open={choosers.worktreeOpen}
        onOpenChange={choosers.setWorktreeOpen}
        data={choosers.worktrees}
        context={choosers.worktreeContext}
        onSelect={choosers.onSwitchWorktree}
      />
    </div>
  );
}
