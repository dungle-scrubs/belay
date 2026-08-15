import { type ArtifactRef, estimateTokens, isContextOverflowText } from "@belay/session";
import { CircleX, PanelRight, RotateCw, TriangleAlert } from "lucide-react";
import { memo, type ReactNode } from "react";
import { RECOVERY_ACTION_LABEL, reconnectActionLabel } from "@/action-label";
import { compactDisplayFor } from "@/components/chat/compact-display";
import { CompactRow } from "@/components/chat/compact-row";
import { CompactingBar } from "@/components/chat/compacting-bar";
import { type ConcurrentTool, ConcurrentTools } from "@/components/chat/concurrent-tools";
import { DoctorResult } from "@/components/chat/doctor/doctor-result";
import { InlineAgentGroup } from "@/components/chat/inline-agent-row";
import { LucidArtifactCard } from "@/components/chat/lucid-artifact-card";
import { MarkdownBody } from "@/components/chat/markdown-body";
import { CommandResult, MessageMeta, ShellBlock, UserMessage } from "@/components/chat/message";
import { messageKindDescriptor, quietMarkerText } from "@/components/chat/message-kind-descriptor";
import { QuestionTranscriptItem } from "@/components/chat/question-item";
import { ReasoningTrace } from "@/components/chat/reasoning-trace";
import { ToneAlert } from "@/components/chat/tone-alert";
import { parseToolArgs, ToolRenderer } from "@/components/chat/tool-message";
import { toolMessageStatus } from "@/components/chat/tool-status";
import { CommandMenu } from "@/components/command-menu/command-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useElapsedLabel } from "@/hooks/use-elapsed-label";
import { WithInspect } from "@/tool-detail/inspect-affordance";
import { fmtCtx, fmtTokens } from "../../derive";
import { toolSummary } from "../../tool-args";
import {
  LEGACY_RECONNECT_ATTEMPTS,
  type Message,
  reconnectDisplayDetail,
  type ToolMessage as ToolMessageData,
} from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

/**
 * Projects one read-only tool message into a concurrent-batch row. Lives beside its renderer (not in
 * App) and shares `toolMessageStatus`, so the batch's status can't diverge from the transcript row's.
 */
function toConcurrentTool(
  tool: ToolMessageData,
  onOpenPath: (path: string) => void,
): ConcurrentTool {
  const path = parseToolArgs(tool.args).path;
  return {
    id: tool.id,
    name: tool.name,
    args: toolSummary(tool.name, tool.args),
    status: toolMessageStatus(tool),
    onOpenPath: typeof path === "string" && path ? () => onOpenPath(path) : undefined,
  };
}

function canExpandCompact(message: Message): boolean {
  if (message.kind === "tool" || message.kind === "shell") {
    return false;
  }
  const display = compactDisplayFor(message);
  return display?.hasDetail === true;
}

function compactRowAction(
  message: Message,
  onOpenArtifact: ((artifact: ArtifactRef) => void) | undefined,
): (() => void) | undefined {
  if (message.kind === "lucid" && onOpenArtifact) {
    return () => onOpenArtifact(message.artifact);
  }
  return undefined;
}

function TranscriptBlock({ children, id }: { readonly children: ReactNode; readonly id: string }) {
  return <div data-message-id={id}>{children}</div>;
}

function compactExpandedDetail(message: Message): ReactNode | null {
  if (message.kind === "assistant" && message.thinking.trim()) {
    return <MarkdownBody text={message.thinking} muted />;
  }
  if (message.kind === "result" && message.text.trim()) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap border-l border-border pl-3 text-sm text-muted-foreground">
        {message.text}
      </pre>
    );
  }
  if (message.kind === "delegation" && message.result?.trim()) {
    return <MarkdownBody text={message.result} muted />;
  }
  return null;
}

function stopTitle(cause: string): string {
  switch (cause) {
    case "context_pressure":
      return "context pressure";
    case "step_backstop":
      return "paused at step backstop";
    case "loop_stalled":
      return "loop stalled";
    case "hook_halt":
      return "halted by hook";
    case "provider_protocol_anomaly":
      return "provider protocol anomaly";
    case "overflow":
      return "context overflow";
    case "no_reply":
      return "no reply";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "error":
      return "error";
    case "answered":
      return "answered";
    default:
      return "turn stopped";
  }
}

/**
 * The inline "working…" indicator for a plain turn (no task, no delegation): the last transcript item.
 * The label is the orange/white `.working-shimmer` sweep (index.css); beside it, the same live parens the
 * pinned header shows - `(elapsed · ↑ tokens)` - with the elapsed timer ticking client-side and the `↑`
 * cell hidden until the first output-token snapshot. The label text stays real (transparent fill) so
 * screen readers still announce it.
 */
function WorkingIndicator({
  startedAt,
  outputTokens,
}: {
  readonly startedAt?: number;
  readonly outputTokens?: number;
}) {
  const elapsed = useElapsedLabel(startedAt);
  const cells = [
    elapsed,
    outputTokens === undefined ? null : `↑ ${fmtTokens(outputTokens)} tokens`,
  ].filter((cell): cell is string => Boolean(cell));
  return (
    <span className="inline-flex items-baseline gap-1.5 text-sm">
      <span className="working-shimmer italic">working…</span>
      {cells.length > 0 ? (
        <span className="text-muted-foreground">({cells.join(" · ")})</span>
      ) : null}
    </span>
  );
}

export interface TranscriptRowViewProps {
  readonly row: TranscriptRow;
  readonly showThinking: boolean;
  readonly onOpenPath: (path: string) => void;
  readonly onOpenArtifact?: (artifact: ArtifactRef) => void;
  readonly onDoctorRefresh: () => void;
  /** Dispatch a nested command-menu row selection back through the command path, e.g. `/style concise`
   *  (plan 03). A leaf action sends a host command; it never starts a model turn. */
  readonly onMenuAction?: (command: string, args: string) => void;
  /** Render resolved-question rows as a single compact line (D-003). Off by default; a future compact
   *  transcript mode flips it on. */
  readonly questionsOneLine?: boolean;
  /** Compact transcript mode (plan 05): collapse non-primary rows (thinking, tools, status, results)
   *  to one line, keeping user prompts + final assistant responses full. Off by default. */
  readonly compact?: boolean;
  /** The compacted message ids whose detail is expanded (compact mode only). */
  readonly expandedRows?: ReadonlySet<string>;
  /** Toggles a compacted row's expanded detail (compact mode only). */
  readonly onToggleRow?: (id: string) => void;
  /** Opens the tool detail takeover for a detail-eligible row (tool call / shell lane), plan 08. The
   *  inspect affordance is only shown on eligible rows, so non-eligible rows are never cluttered. */
  readonly onOpenDetail?: (message: Message) => void;
  /** Opens the inline-agent detail takeover for a child session id (plan 09.4 M6). */
  readonly onOpenAgent?: (childSessionId: string) => void;
  /** Compact-only presentation: hide the repeated icon + label for consecutive same-tool rows. */
  readonly suppressCompactPrimary?: boolean;
}

function TranscriptRowViewImpl({
  row,
  showThinking,
  onOpenPath,
  onOpenArtifact,
  onDoctorRefresh,
  onMenuAction,
  questionsOneLine = false,
  compact = false,
  expandedRows,
  onToggleRow,
  onOpenDetail,
  onOpenAgent,
  suppressCompactPrimary = false,
}: TranscriptRowViewProps) {
  // Compact mode collapses an eligible message row to a one-line CompactRow; its detail, when expanded,
  // is the SAME full renderer (a recursive render with compact off), so no renderer is duplicated. The
  // tool_batch + working rows are already dense, so they keep their normal rendering.
  if (compact && row.kind === "message") {
    const display = compactDisplayFor(row.message);
    if (display) {
      const expanded = expandedRows?.has(row.message.id) ?? false;
      const expandedDetail = expanded ? compactExpandedDetail(row.message) : null;
      const onExpand =
        canExpandCompact(row.message) && onToggleRow
          ? () => onToggleRow(row.message.id)
          : undefined;
      const onAction = compactRowAction(row.message, onOpenArtifact);
      // Carry the selection segment id on the compact wrapper unless a recursive full render below owns
      // it, so exactly one element holds each message id (a duplicate would split the transcript-selection
      // capture vs. resolve and misplace the persistent highlight). The inspect affordance wraps the
      // collapsed row too, so a tool/shell can be inspected without first expanding.
      return (
        <WithInspect message={row.message} onOpenDetail={onOpenDetail}>
          <div data-message-id={expanded && !expandedDetail ? undefined : row.message.id}>
            <CompactRow
              display={display}
              expanded={expanded}
              onToggle={onExpand}
              onAction={onAction}
              suppressPrimary={suppressCompactPrimary}
            >
              {expanded
                ? (expandedDetail ?? (
                    <TranscriptRowView
                      row={row}
                      compact={false}
                      showThinking={showThinking}
                      onOpenPath={onOpenPath}
                      onOpenArtifact={onOpenArtifact}
                      onDoctorRefresh={onDoctorRefresh}
                      onMenuAction={onMenuAction}
                      questionsOneLine={questionsOneLine}
                    />
                  ))
                : null}
            </CompactRow>
          </div>
        </WithInspect>
      );
    }
  }

  if (row.kind === "tool_batch") {
    if (compact) {
      return (
        <div className="flex flex-col">
          {row.tools.map((tool, index) => {
            const display = compactDisplayFor(tool);
            if (!display) {
              return null;
            }
            return (
              <WithInspect key={tool.id} message={tool} onOpenDetail={onOpenDetail}>
                <div data-message-id={tool.id}>
                  <CompactRow
                    display={display}
                    suppressPrimary={index > 0 && tool.name === row.tools[index - 1]?.name}
                  />
                </div>
              </WithInspect>
            );
          })}
        </div>
      );
    }
    return <ConcurrentTools tools={row.tools.map((tool) => toConcurrentTool(tool, onOpenPath))} />;
  }

  if (row.kind === "working") {
    return <WorkingIndicator startedAt={row.startedAt} outputTokens={row.outputTokens} />;
  }

  const message = row.message;
  if (message.kind === "tool") {
    // data-message-id makes the tool block a selectable transcript segment, so a cross-item
    // selection can start or end inside tool output (02.11). The wrapper carries no styling;
    // ToolRenderer keeps owning its own indent/layout.
    return (
      <WithInspect message={message} onOpenDetail={onOpenDetail}>
        <div data-message-id={message.id}>
          <ToolRenderer message={message} onOpenPath={onOpenPath} />
        </div>
      </WithInspect>
    );
  }

  if (message.kind === "lucid") {
    return (
      <div data-message-id={message.id}>
        <LucidArtifactCard
          title={message.title}
          version={message.version}
          artifact={message.artifact}
          onOpenArtifact={onOpenArtifact}
        />
      </div>
    );
  }

  if (message.kind === "result") {
    return (
      <TranscriptBlock id={message.id}>
        {message.menu ? (
          <div className="overflow-hidden rounded-md border border-border">
            <CommandMenu
              payload={message.menu}
              onAction={(family, actionId) => onMenuAction?.(`/${family}`, actionId)}
            />
          </div>
        ) : message.command === "/doctor" ? (
          <DoctorResult
            command={message.command}
            text={message.text}
            ok={message.ok}
            onRefresh={onDoctorRefresh}
          />
        ) : (
          <CommandResult command={message.command} text={message.text} ok={message.ok} />
        )}
      </TranscriptBlock>
    );
  }

  if (message.kind === "question") {
    return (
      <div data-message-id={message.id}>
        <QuestionTranscriptItem message={message} oneLine={questionsOneLine} />
      </div>
    );
  }

  if (message.kind === "shell") {
    return (
      <WithInspect message={message} onOpenDetail={onOpenDetail}>
        <TranscriptBlock id={message.id}>
          <ShellBlock
            command={message.command}
            output={message.output}
            done={message.done}
            ok={message.ok}
          />
        </TranscriptBlock>
      </WithInspect>
    );
  }

  if (message.kind === "recovered") {
    const reclaimed =
      message.reclaimed > 0 ? ` · ~${fmtTokens(estimateTokens(message.reclaimed))} reclaimed` : "";
    return (
      <ToneAlert tone="yellow" icon={RotateCw} title="context full">
        {message.detail}
        {reclaimed} · {RECOVERY_ACTION_LABEL}
      </ToneAlert>
    );
  }

  if (message.kind === "continued") {
    // A QUIET breadcrumb (02.17): the loop auto-continued past the adaptive step budget because there
    // was context headroom and progress. Deliberately understated muted text - NOT the alarming
    // step_backstop pause card (which renders only on a genuine terminating stop).
    const descriptor = messageKindDescriptor(message);
    const Icon = descriptor.icon;
    return (
      <div className="flex items-center gap-1.5 text-label tracking-wide text-muted-foreground/70">
        <Icon className="size-3 shrink-0" />
        {quietMarkerText(descriptor)}
      </div>
    );
  }

  if (message.kind === "modelSwitch") {
    // A quiet inline breadcrumb (09.1): the turn changed model and/or reasoning at a step boundary. Each
    // side shows `model (reasoning)`, so a reasoning-only change reads `X (high) -> X (medium)`; a blocked
    // larger->smaller switch shows the guard's reason instead of a delta. Understated like the checkpoint
    // breadcrumb, not an alarming card.
    const descriptor = messageKindDescriptor(message);
    const Icon = descriptor.icon;
    return (
      <div className="flex items-center gap-1.5 text-label tracking-wide text-muted-foreground/70">
        <Icon className="size-3 shrink-0" />
        {quietMarkerText(descriptor)}
      </div>
    );
  }

  if (message.kind === "limit") {
    // A provider usage-limit marker (plan 44.4). `approaching` is a QUIET muted breadcrumb (like the
    // model-switch marker) - background activity, not alarming. `reached` is the LOUDER alert (a yellow
    // ToneAlert, like `recovered`) since the window is actually exhausted. Both humanize `resetsAt` via
    // the shared summary. Detection only - neither offers an action; the transcript just records it.
    const descriptor = messageKindDescriptor(message);
    const Icon = descriptor.icon;
    if (message.status === "reached") {
      return (
        <ToneAlert tone="yellow" icon={Icon} title="usage limit reached">
          {descriptor.secondary}
        </ToneAlert>
      );
    }
    return (
      <div className="flex items-center gap-1.5 text-label tracking-wide text-muted-foreground/70">
        <Icon className="size-3 shrink-0" />
        {quietMarkerText(descriptor)}
      </div>
    );
  }

  if (message.kind === "guardrail") {
    // A quiet, REDACTED advisory (plan 07): the loop flagged a repeating tool path. It shows only the
    // tool, the reason, and the repeat count - never the arguments, output, or fingerprints (D-005).
    // Deliberately understated muted text, like the checkpoint breadcrumb, not an alarming card.
    const descriptor = messageKindDescriptor(message);
    const Icon = descriptor.icon;
    return (
      <div className="flex items-center gap-1.5 text-label tracking-wide text-muted-foreground/70">
        <Icon className="size-3 shrink-0" />
        {quietMarkerText(descriptor)}
      </div>
    );
  }

  if (message.kind === "hookDecision") {
    // A visible hook decision (plan 25 M9): a quiet, attributed advisory line - the hook's
    // approval key, what it did (denied a tool / halted the turn / added context), and its
    // already-redacted reason. Understated like the guardrail marker, never an alarming card.
    const descriptor = messageKindDescriptor(message);
    const Icon = descriptor.icon;
    return (
      <div className="flex items-center gap-1.5 text-label tracking-wide text-muted-foreground/70">
        <Icon className="size-3 shrink-0" />
        {quietMarkerText(descriptor)}
      </div>
    );
  }

  if (message.kind === "reconnecting") {
    return (
      <ToneAlert tone="blue" icon={RotateCw} title="connection dropped">
        {reconnectDisplayDetail(message.detail)} ·{" "}
        {reconnectActionLabel(message.attempt, message.maxAttempts ?? LEGACY_RECONNECT_ATTEMPTS)}
      </ToneAlert>
    );
  }

  if (message.kind === "compacting") {
    return <CompactingBar tokens={message.tokens} budget={message.budget} />;
  }

  if (message.kind === "inlineAgent") {
    // An inline delegation (plan 09.4): the compact inline-agent row(s), grouped when a turn spawned
    // several. Clicking a row opens the child's live transcript takeover (M6) via onOpenAgent.
    return <InlineAgentGroup agents={message.agents} onOpen={onOpenAgent} />;
  }

  if (message.kind === "delegation") {
    // Background delegation only now (inline reduces to `inlineAgent` above, plan 09.4): the purple
    // linked block with the async verb.
    const running = message.status === "running";
    const failed = message.status === "failed";
    const tone = failed ? "text-smui-red" : running ? "text-smui-purple" : "text-smui-green";
    const verb = running ? "running in background…" : failed ? "delegation failed" : "delegated";
    return (
      <ToneAlert
        tone="purple"
        icon={PanelRight}
        title={
          <>
            {message.agent} · {verb}
          </>
        }
        titleClassName={tone}
      >
        <div className="text-muted-foreground">{message.task}</div>
        {message.result ? <div className="mt-1 whitespace-pre-wrap">{message.result}</div> : null}
      </ToneAlert>
    );
  }

  const thinking =
    message.kind === "assistant" && showThinking && message.thinking ? message.thinking : null;

  // Reasoning streams while the assistant turn has produced no answer text and has not finished; once
  // the answer starts or the turn settles, the trace auto-collapses. Derived here (not in the protocol)
  // so the reasoning surface stays a pure presentation of the `thinking` string (plan 35 M2).
  const reasoningStreaming = message.kind === "assistant" && !message.done && !message.text;

  const overflowNote =
    message.kind === "assistant" && message.overflow ? (
      <ToneAlert tone="yellow" icon={TriangleAlert} title="context overflow">
        {message.overflow}
      </ToneAlert>
    ) : null;

  const errorNote =
    message.kind === "assistant" && message.error ? (
      <Alert variant="destructive">
        <CircleX className="h-3.5 w-3.5" />
        <AlertTitle>
          {isContextOverflowText(message.error) ? "context overflow" : "error"}
        </AlertTitle>
        <AlertDescription>{message.error}</AlertDescription>
      </Alert>
    ) : null;

  const cancelledNote =
    message.kind === "assistant" && message.cancelled ? (
      <div className="text-sm text-smui-red">cancelled</div>
    ) : null;

  const steeredNote =
    message.kind === "assistant" && message.steered ? (
      <div className="text-sm text-muted-foreground/60">steered</div>
    ) : null;

  const interruptedNote =
    message.kind === "assistant" && message.interrupted ? (
      <div className="text-sm text-smui-red">interrupted · host restarted</div>
    ) : null;

  const noReplyNote =
    message.kind === "assistant" && message.noReply ? (
      <ToneAlert tone="yellow" icon={TriangleAlert} title="no reply">
        The model ended the turn without a reply. Try again or rephrase.
      </ToneAlert>
    ) : null;

  // A malformed-protocol incident (D-005): the model rendered raw tool-call markup as assistant text.
  // The leaked markup is `message.text`; rendering it through MarkdownBody would interpret the tags, so
  // the anomaly alert shows it ESCAPED in a bounded block instead. The web stays provider-neutral - it
  // keys on the typed `reason`, never on any DeepSeek-specific string. This note replaces both the raw
  // markdown body and the generic stop note for the message, so the leak is explained exactly once.
  const anomaly =
    message.kind === "assistant" && message.diagnostic?.reason === "protocol_anomaly"
      ? message.diagnostic
      : null;
  const anomalyNote =
    anomaly && message.kind === "assistant" ? (
      <ToneAlert tone="yellow" icon={TriangleAlert} title="provider protocol anomaly">
        <div>{anomaly.detail}</div>
        {message.text ? (
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-label text-muted-foreground">
            {message.text.slice(0, 2000)}
          </pre>
        ) : null}
      </ToneAlert>
    ) : null;

  let stepLimitNote: ReactNode = null;
  if (message.kind === "assistant" && !anomaly) {
    if (message.stop) {
      stepLimitNote = (
        <ToneAlert
          tone="yellow"
          icon={TriangleAlert}
          title={stopTitle(message.stop.cause)}
          descriptionClassName="break-words"
        >
          <div>{message.stop.summary.slice(0, 240)}</div>
        </ToneAlert>
      );
    } else if (message.stepLimit) {
      stepLimitNote = (
        <div className="text-label text-muted-foreground">
          legacy step budget reached after {message.stepLimit} steps
        </div>
      );
    }
  }

  if (message.kind === "assistant" && !message.text && !message.done) {
    // The live "thinking/streaming/loading" indicator now lives in the ONE pinned TurnStatusHeader
    // (plan 50), so a silent in-flight segment no longer renders its own ActionShimmer fallback - that
    // would be a second live indicator (R-4). Actual reasoning-token content (ReasoningTrace) is real
    // content, not a duplicate indicator, so it still renders here, as do any overflow/error notes.
    if (!thinking && !overflowNote && !errorNote) {
      return null;
    }
    return (
      <div className="flex flex-col gap-3">
        {thinking ? <ReasoningTrace content={thinking} streaming={reasoningStreaming} /> : null}
        {overflowNote}
        {errorNote}
      </div>
    );
  }

  let metaItems: string[] | null = null;
  if (message.kind === "assistant" && message.usage) {
    const usage = message.usage;
    metaItems = [message.model, `${fmtTokens(usage.input)}/${fmtCtx(usage.contextWindow)} ctx`];
    if (usage.genMs > 0) {
      metaItems.push(`${Math.round(usage.output / (usage.genMs / 1000))} tok/s`);
    }
  }

  if (message.kind === "user") {
    return (
      <TranscriptBlock id={message.id}>
        <UserMessage
          text={message.text}
          artifacts={message.artifacts}
          pastes={message.pastes}
          onOpenArtifact={onOpenArtifact}
        />
      </TranscriptBlock>
    );
  }

  return (
    <div data-message-id={message.id} className="flex flex-col gap-3">
      {thinking ? <ReasoningTrace content={thinking} streaming={reasoningStreaming} /> : null}
      {anomalyNote ??
        (message.text ? <MarkdownBody text={message.text} mermaid={message.done} /> : null)}
      {overflowNote}
      {errorNote}
      {cancelledNote}
      {steeredNote}
      {interruptedNote}
      {noReplyNote}
      {stepLimitNote}
      {metaItems ? <MessageMeta items={metaItems} /> : null}
    </div>
  );
}

/**
 * Row equality one level deep (Tier 1): `buildTranscriptRows` mints FRESH wrapper objects on every
 * fold (any appended event), but the projector guarantees the underlying Message objects keep
 * identity for untouched rows. Comparing the wrapper's fields - and, for a tool batch, its tool
 * messages element-wise (the batch arrays are also rebuilt per fold) - recovers that stability, so
 * the memo below skips exactly the rows a batch of events did not mutate.
 */
function sameTranscriptRow(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a === b) {
    return true;
  }
  if (a.kind !== b.kind || a.id !== b.id) {
    return false;
  }
  if (a.kind === "working" || b.kind === "working") {
    // The elapsed timer ticks inside WorkingIndicator (its own interval), so only a metrics change needs
    // a re-render here; `startedAt` is stable within a turn, `outputTokens` grows as the model streams.
    // (`a.kind === b.kind` already holds, so both are the working row when either is.)
    return (
      a.kind === "working" &&
      b.kind === "working" &&
      a.startedAt === b.startedAt &&
      a.outputTokens === b.outputTokens
    );
  }
  if (a.compactAbove !== b.compactAbove) {
    return false;
  }
  if (a.kind === "message" && b.kind === "message") {
    return a.message === b.message;
  }
  if (a.kind === "tool_batch" && b.kind === "tool_batch") {
    return (
      a.tools === b.tools ||
      (a.tools.length === b.tools.length && a.tools.every((tool, i) => tool === b.tools[i]))
    );
  }
  return false;
}

/** Shallow-compare every prop except `row`, which gets the structural one-level compare above. Keyed
 *  off the prop NAMES at call time (not a hardcoded list), so adding a prop can never silently skip
 *  its comparison. */
function transcriptRowViewPropsEqual(
  prev: TranscriptRowViewProps,
  next: TranscriptRowViewProps,
): boolean {
  const keys = Object.keys(next) as readonly (keyof TranscriptRowViewProps)[];
  if (keys.length !== Object.keys(prev).length) {
    return false;
  }
  for (const key of keys) {
    if (key === "row") {
      continue;
    }
    if (!Object.is(prev[key], next[key])) {
      return false;
    }
  }
  return sameTranscriptRow(prev.row, next.row);
}

/**
 * The per-row memo boundary (Tier 1): during a streaming turn only the mutated row(s) re-render;
 * every untouched row is skipped here, cutting the per-token render cost from O(transcript) to O(1)
 * rows. Effective because Tier 0's projector keeps untouched Message identity and App passes stable
 * (useMemoizedFn) callbacks through rowConfig.
 */
export const TranscriptRowView = memo(TranscriptRowViewImpl, transcriptRowViewPropsEqual);
