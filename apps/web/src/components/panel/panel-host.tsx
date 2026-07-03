import type {
  ArtifactRef,
  CommandSpec,
  GitStatus,
  JobSnapshot,
  LoopControl,
  LoopInventoryRow,
  ProviderQuestionAnswer,
  SessionActivity,
  SessionSummary,
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
import { QuoteSelectionToolbar } from "@/components/assistant-ui/quote-selection-toolbar";
import { ArchivedNotice } from "@/components/chat/archived-notice";
import { CommandMenu } from "@/components/chat/command-menu";
import { LoopInventory } from "@/components/chat/loop/loop-inventory";
import { WorkingIndicator } from "@/components/chat/message";
import { PromptInput } from "@/components/chat/prompt-input";
import { QueuedPrompts } from "@/components/chat/queued-prompts";
import { VirtualTranscript } from "@/components/chat/virtual-transcript";
import { RowChooserModal } from "@/components/command-modal";
import { HandoffApprovalSurface } from "@/components/handoff/handoff-approval-surface";
import { SessionSidebar } from "@/components/panel/session-sidebar";
import { DrawerToggle } from "@/components/panel/side-drawer";
import { SidePanel, SidePanelBreakdown, SidePanelHeader } from "@/components/panel/side-panel";
import { QuestionSurface } from "@/components/question";
import type { Composer } from "@/hooks/use-composer";
import { cn } from "@/lib/utils";
import type { ScrollFollowController } from "@/scroll-follow";
import type { SessionStream } from "@/session/use-session";
import type { HostStatus, PendingHandoff, PendingQuestion } from "../../derive";
import { type InventoryState, RESUME_CHOOSER, type ResumeContext } from "../../resume";
import type { QueuedPrompt } from "../../send-queue";
import type { SupportSubagent } from "../../support-panel/support-panel";
import { SupportPanel } from "../../support-panel/support-panel-view";
import type { Message, PanelModel, readOnlyToolBatches, toTranscript } from "../../transcript";
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
  readonly onOpenPath: (path: string) => void;
  readonly onOpenArtifact?: (artifact: ArtifactRef) => void;
  /** Re-runs `/doctor` on the host (a no-model-turn immediate command), wired to the dashboard's
   *  refresh control. App owns it because it depends on the session command action. */
  readonly onDoctorRefresh: () => void;
  /** Dispatch a nested command-menu row selection as a host command (plan 03), e.g. `/style concise`. */
  readonly onMenuAction?: (command: string, args: string) => void;
  /** Open the tool detail takeover for a detail-eligible transcript row (plan 08). */
  readonly onOpenDetail?: (message: Message) => void;
  readonly showThinking: boolean;
  /** Compact transcript layout (plan 05): collapse non-primary rows to one line. */
  readonly compact: boolean;
  /** The running run id, or null once the turn ends; drives the persistent "Working" pulse. */
  readonly active: string | null;
  readonly awaitingResponse: boolean;
  readonly turnStartedAt: number | null;
  readonly queue: readonly QueuedPrompt[];
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
 * The session navigation sidebar binding (D-093): the left-hand session list. App owns the open
 * state, the current-project inventory, the live-activity overlay, and the guarded switch action;
 * PanelHost renders the rail (when open) and the upper-left dashboard toggle (when closed).
 */
export interface SidebarBinding {
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly sessions: readonly SessionSummary[];
  readonly currentSessionId: string;
  readonly currentProject: string | null;
  readonly onSelect: (sessionId: string) => void;
  /** Durably rename a session row (editable session titles). */
  readonly onRename: (sessionId: string, title: string) => void;
  /** Archive a session row (right-click → Archive): hides it from the sidebar/resume. */
  readonly onArchive: (sessionId: string) => void;
  /** Soft-delete a session row (right-click → Delete, confirmed): hides it from every view. */
  readonly onDelete: (sessionId: string) => void;
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
  /** Dismiss the whole checklist (the abandoned-list escape hatch). */
  onClearTasks?: () => void;
  /** Background subagents (running delegations) for the support panel (plan 09). */
  subagents?: readonly SupportSubagent[];
  /** Promoted background jobs for the support panel (plan 09). */
  jobs?: readonly JobSnapshot[];
  /** Open a promoted job's detail takeover (plan 09 M8). */
  onOpenJobDetail?: (jobId: string) => void;
  /** Stop a running promoted job (plan 09 M8). */
  onKillJob?: (jobId: string) => void;
  panel: PanelBinding;
  artifactPanel?: ArtifactPanelBinding;
  choosers: ChooserBinding;
  sidebar: SidebarBinding;
  /** A short name for the open session, shown in the main header strip (D-093). */
  sessionName: string;
  /** The full model chooser (D-065), rendered as a takeover of the transcript/composer center column
   *  while the sidebars stay visible. Undefined (the common case) when the chooser is closed. */
  chooser?: ReactNode;
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
    onClearTasks,
    subagents,
    jobs,
    onOpenJobDetail,
    onKillJob,
    panel,
    artifactPanel,
    choosers,
  } = props;
  const { sidebar, sessionName, chooser, archived, onUnarchive, question, handoff } = props;
  const { replayed } = stream;
  const {
    transcript,
    toolBatches,
    onOpenPath,
    onOpenArtifact,
    onDoctorRefresh,
    onMenuAction,
    onOpenDetail,
    showThinking,
    compact,
    queue,
  } = tv;
  const { active, awaitingResponse, turnStartedAt } = tv;
  const rows = useMemo(
    () =>
      buildTranscriptRows({
        active,
        awaitingResponse,
        toolBatches,
        transcript,
        turnStartedAt,
      }),
    [active, awaitingResponse, toolBatches, transcript, turnStartedAt],
  );
  // Every scroll event reaches the controller, even before the list reveals (`data-transcript-ready`
  // false). The controller recognizes its own settle-loop writes as self-writes, so they no longer need
  // to be dropped here to avoid a false unpin (plan 12.2); dropping them was one of the flick-reset causes.
  const onTranscriptScroll = () => {
    scroll.onScroll();
  };

  return (
    <div className="flex h-svh">
      {/* The session navigation sidebar (D-093): a collapsible left rail listing the current
        project's sessions. Switching routes through the same safe path as `/resume`. */}
      {sidebar.open ? (
        <SessionSidebar
          sessions={sidebar.sessions}
          currentSessionId={sidebar.currentSessionId}
          currentProject={sidebar.currentProject}
          onSelect={sidebar.onSelect}
          onRename={sidebar.onRename}
          onArchive={sidebar.onArchive}
          onDelete={sidebar.onDelete}
          liveActivity={sidebar.liveActivity}
          onToggle={sidebar.onClose}
          nowMs={sidebar.nowMs}
          className="w-64 shrink-0"
        />
      ) : null}
      <main className="relative flex min-w-0 flex-1 flex-col bg-smui-surface-sunken px-4">
        {/* Highlight text in any message (data-message-id) to get a floating Quote action
          that drops the selection into the composer as a markdown blockquote. */}
        <QuoteSelectionToolbar onQuote={composer.quoteSelection} />
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
        {/* Transcript fills the view; the composer + footer pin to the bottom.
          Scrollbar is hidden but the region still scrolls. The relative wrapper anchors
          the jump-to-bottom chevron over the transcript's lower edge. */}
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
            className="flex flex-1 flex-col overflow-y-auto py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {/* Three states, so the page never looks broken while things come up:
              1. still replaying the session stream -> a brief "connecting to session" state;
              2. replayed + empty + no host joined yet (e.g. just opened via `trevor`, host booting)
                 -> a clear "waiting for host" state that vanishes once the host announces online;
              3. otherwise -> the full history (existing session pinned to bottom, empty at top), 150ms fade. */}
            {!replayed ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2">
                <WorkingIndicator label="connecting to session" />
              </div>
            ) : !host.leaderId && transcript.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <WorkingIndicator label={host.present ? "connecting to host" : "starting host"} />
                <span className="text-label tracking-wider text-muted-foreground/70">
                  waiting for the agent host to start and join this session…
                </span>
              </div>
            ) : (
              <VirtualTranscript
                rows={rows}
                scrollRef={scroll.transcriptRef}
                controller={scroll.controller}
                pinned={scroll.atBottom}
                scrollToBottomRequest={scroll.bottomRequestId}
                showThinking={showThinking}
                compact={compact}
                onOpenPath={onOpenPath}
                onOpenArtifact={onOpenArtifact}
                onOpenDetail={onOpenDetail}
                onDoctorRefresh={onDoctorRefresh}
                onMenuAction={onMenuAction}
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

        {/* Live task checklist, above the composer. */}
        <SupportPanel
          tasks={tasks}
          subagents={subagents ?? []}
          jobs={jobs ?? []}
          stale={tasksStale}
          onClearTasks={onClearTasks}
          onOpenJobDetail={onOpenJobDetail}
          onKillJob={onKillJob}
        />

        {loopInventory.rows.length > 0 ? (
          <LoopInventory
            className="mb-2"
            rows={loopInventory.rows}
            onControl={loopInventory.onControl}
          />
        ) : null}

        <QueuedPrompts queue={queue} />

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

              <PromptInput
                composer={composer}
                onSubmit={compose.onSubmit}
                onKeyDown={compose.onInputKeyDown}
                disabled={compose.disabled}
                placeholder={compose.placeholder}
                onExpand={compose.onExpand}
                vimEnabled={compose.vimEnabled}
                menuOpen={compose.menuOpen}
              />
            </>
          )}
        </div>
      </main>

      {artifactPanel ? (
        <ArtifactPanel
          artifact={artifactPanel.artifact}
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
