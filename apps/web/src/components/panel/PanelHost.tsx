import type { CommandSpec, GitStatus, TaskSnapshot, WorktreeSummary } from "@trevor/session";
import { ChevronDown, CircleX, PanelRight, RotateCw, TriangleAlert } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject, SubmitEvent } from "react";
import { QuoteSelectionToolbar } from "@/components/assistant-ui/quote-selection-toolbar";
import { CommandMenu } from "@/components/chat/command-menu";
import { CompactingBar } from "@/components/chat/compacting-bar";
import { type ConcurrentTool, ConcurrentTools } from "@/components/chat/concurrent-tools";
import {
  CommandResult,
  MessageMeta,
  ShellBlock,
  ThinkingMessage,
  WorkingIndicator,
} from "@/components/chat/message";
import { PromptInput } from "@/components/chat/prompt-input";
import { ToolMessage } from "@/components/chat/tool-message";
import { SidePanel } from "@/components/panel/SidePanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Composer } from "@/hooks/use-composer";
import { cn } from "@/lib/utils";
import type { SessionStream } from "@/session/use-session";
import { ArtifactThumb } from "../../ArtifactThumb";
import { fmtCtx, fmtTokens, type HostStatus, isOverflowError } from "../../derive";
import { Markdown } from "../../markdown";
import { type InventoryState, type ResumeContext, ResumeModal } from "../../resume";
import type { QueuedPrompt } from "../../send-queue";
import { TasksPanel } from "../../TasksPanel";
import type {
  PanelModel,
  readOnlyToolBatches,
  ToolMessage as ToolMessageData,
  toTranscript,
} from "../../transcript";
import { WorktreeModal } from "../../worktrees";
import type { WorktreeRowsContext } from "../../worktrees/worktree-rows";

// SMUI-themed markdown body: reuses the app's Markdown renderer, re-themed via the
// .smui-md scope in index.css.
function Md({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <div className={cn("smui-md text-sm", muted ? "text-muted-foreground" : "text-foreground")}>
      <Markdown text={text} muted={muted} />
    </div>
  );
}

type Transcript = ReturnType<typeof toTranscript>;
type ToolBatches = ReturnType<typeof readOnlyToolBatches>;

/**
 * The transcript view-model: the coalesced messages plus the live-turn + queue state and the
 * read-only-batch grouping/handlers needed to render each row. Pure data + callbacks, no state.
 */
export interface TranscriptView {
  readonly transcript: Transcript;
  readonly toolBatches: ToolBatches;
  readonly toConcurrentTool: (tool: ToolMessageData) => ConcurrentTool;
  readonly onOpenPath: (path: string) => void;
  readonly showThinking: boolean;
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
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly atBottom: boolean;
  readonly onScroll: () => void;
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
 * PanelHost owns the rendered chat layout: the main column (transcript well + task checklist +
 * composer), the toggleable side panel, and the resume/worktree choosers. It owns NO state - it is
 * pure presentation over the injected view-models and wiring. App stays the composition root: it
 * wires the hooks (session, composer, send queue) and folds the memos (transcript, panelModel,
 * host), then hands them here as cohesive objects. The JSX is moved verbatim from App.tsx - same
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
  panel: PanelBinding;
  choosers: ChooserBinding;
}) {
  const { composer, compose, stream, host, transcript: tv, scroll, tasks, panel, choosers } = props;
  const { replayed } = stream;
  const { transcript, toolBatches, toConcurrentTool, onOpenPath, showThinking, queue } = tv;
  const { active, awaitingResponse, turnStartedAt } = tv;

  return (
    <div className="flex h-svh">
      <main className="relative flex min-w-0 flex-1 flex-col bg-smui-surface-sunken px-4">
        {/* Highlight text in any message (data-message-id) to get a floating Quote action
          that drops the selection into the composer as a markdown blockquote. */}
        <QuoteSelectionToolbar onQuote={composer.quoteSelection} />
        {!panel.open ? (
          <button
            type="button"
            onClick={panel.onOpen}
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
            ref={scroll.transcriptRef}
            onScroll={scroll.onScroll}
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
              <div
                ref={scroll.contentRef}
                className="flex flex-col gap-8 fade-in animate-in duration-150"
              >
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
                        onOpenPath={onOpenPath}
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
                  if (message.kind === "shell") {
                    // The prompt shell lane (D-082): a leading `!` ran a command on the host. Rendered
                    // as a terminal block (`$ command` + output), pending until its result lands. No
                    // left padding (unlike assistant/tool rows): the box sits flush at the content-
                    // column left edge, aligned with the user-prompt blocks.
                    return (
                      <ShellBlock
                        key={message.id}
                        command={message.command}
                        output={message.output}
                        done={message.done}
                        ok={message.ok}
                      />
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
                    message.kind === "assistant" && showThinking && message.thinking
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
                    <WorkingIndicator
                      label="Working"
                      startedAt={turnStartedAt ?? undefined}
                      interruptible
                    />
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
            )}
          </div>
          {!scroll.atBottom ? (
            <button
              type="button"
              onClick={scroll.scrollToBottom}
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
          onDrop={composer.onDrop}
          onDragOver={(event) => event.preventDefault()}
          className="relative shrink-0 pt-2 pb-4"
        >
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
            draft={composer.draft}
            onDraftChange={composer.setDraft}
            onSubmit={compose.onSubmit}
            onKeyDown={compose.onInputKeyDown}
            onPaste={composer.onPaste}
            inputRef={composer.inputRef}
            fileInputRef={composer.fileInputRef}
            onPickFiles={composer.onPickFiles}
            disabled={compose.disabled}
            placeholder={compose.placeholder}
            attachments={composer.attachments}
            onRemoveAttachment={composer.removeAttachment}
            uploading={composer.uploading}
            uploadError={composer.uploadError}
            onDismissError={() => composer.setUploadError(null)}
          />
        </div>
      </main>

      {panel.open ? (
        <SidePanel
          title={panel.title}
          subtitle={panel.subtitle}
          statusNode={panel.statusNode}
          workspace={panel.workspace}
          git={panel.git}
          {...panel.model}
          ready={panel.ready}
          controls={panel.controls}
          footer={panel.footer}
          onClose={panel.onClose}
        />
      ) : null}

      <ResumeModal
        open={choosers.resumeOpen}
        onOpenChange={choosers.setResumeOpen}
        sessions={choosers.inventory.sessions}
        loading={choosers.inventory.loading}
        error={choosers.inventory.error}
        context={choosers.resumeContext}
        onResume={choosers.onResume}
      />

      <WorktreeModal
        open={choosers.worktreeOpen}
        onOpenChange={choosers.setWorktreeOpen}
        worktrees={choosers.worktrees}
        context={choosers.worktreeContext}
        onSwitch={choosers.onSwitchWorktree}
      />
    </div>
  );
}
