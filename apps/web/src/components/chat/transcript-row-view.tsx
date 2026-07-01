import { type ArtifactRef, estimateTokens, isContextOverflowText } from "@trevor/session";
import {
  ArrowLeftRight,
  CircleX,
  CornerDownRight,
  PanelRight,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { compactDisplayFor } from "@/components/chat/compact-display";
import { CompactRow } from "@/components/chat/compact-row";
import { CompactingBar } from "@/components/chat/compacting-bar";
import { type ConcurrentTool, ConcurrentTools } from "@/components/chat/concurrent-tools";
import { DoctorResult } from "@/components/chat/doctor/doctor-result";
import { MarkdownBody } from "@/components/chat/markdown-body";
import {
  CommandResult,
  MessageMeta,
  ShellBlock,
  ThinkingMessage,
  UserMessage,
  WorkingIndicator,
} from "@/components/chat/message";
import { QuestionTranscriptItem } from "@/components/chat/question-item";
import { ToneAlert } from "@/components/chat/tone-alert";
import { parseToolArgs, ToolRenderer } from "@/components/chat/tool-message";
import { toolMessageStatus } from "@/components/chat/tool-status";
import { CommandMenu } from "@/components/command-menu/command-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WithInspect } from "@/tool-detail/inspect-affordance";
import { fmtCtx, fmtTokens, toolSummary } from "../../derive";
import {
  formatSwitchEndpoint,
  LEGACY_RECONNECT_ATTEMPTS,
  type Message,
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

function stopTitle(cause: string): string {
  switch (cause) {
    case "context_pressure":
      return "context pressure";
    case "step_backstop":
      return "paused at step backstop";
    case "loop_stalled":
      return "loop stalled";
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
}

export function TranscriptRowView({
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
}: TranscriptRowViewProps) {
  // Compact mode collapses an eligible message row to a one-line CompactRow; its detail, when expanded,
  // is the SAME full renderer (a recursive render with compact off), so no renderer is duplicated. The
  // tool_batch + working rows are already dense, so they keep their normal rendering.
  if (compact && row.kind === "message") {
    const display = compactDisplayFor(row.message);
    if (display) {
      const expanded = expandedRows?.has(row.message.id) ?? false;
      // Carry the selection segment id on the wrapper only while COLLAPSED; when expanded, the recursive
      // full render below owns it, so exactly one element holds each message id (a duplicate would split
      // the transcript-selection capture vs. resolve and misplace the persistent highlight). The inspect
      // affordance wraps the collapsed row too, so a tool/shell can be inspected without first expanding.
      return (
        <WithInspect message={row.message} onOpenDetail={onOpenDetail} className="pl-3.5">
          <div data-message-id={expanded ? undefined : row.message.id}>
            <CompactRow
              display={display}
              expanded={expanded}
              onToggle={
                display.hasDetail && onToggleRow ? () => onToggleRow(row.message.id) : undefined
              }
            >
              {expanded ? (
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
              ) : null}
            </CompactRow>
          </div>
        </WithInspect>
      );
    }
  }

  if (row.kind === "tool_batch") {
    return (
      <div className="pl-3.5">
        <ConcurrentTools tools={row.tools.map((tool) => toConcurrentTool(tool, onOpenPath))} />
      </div>
    );
  }

  if (row.kind === "working") {
    return (
      <div className="pl-3.5">
        <WorkingIndicator
          label="Working"
          startedAt={row.startedAt}
          interruptible={row.interruptible}
        />
      </div>
    );
  }

  const message = row.message;
  if (message.kind === "tool") {
    // data-message-id makes the tool block a selectable transcript segment, so a cross-item
    // selection can start or end inside tool output (02.11). The wrapper carries no styling;
    // ToolRenderer keeps owning its own indent/layout.
    return (
      <WithInspect message={message} onOpenDetail={onOpenDetail}>
        <div data-message-id={message.id}>
          <ToolRenderer message={message} className="pl-3.5" onOpenPath={onOpenPath} />
        </div>
      </WithInspect>
    );
  }

  if (message.kind === "result") {
    return (
      <div data-message-id={message.id} className="pl-3.5">
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
      </div>
    );
  }

  if (message.kind === "question") {
    return (
      <div data-message-id={message.id} className="pl-3.5">
        <QuestionTranscriptItem message={message} oneLine={questionsOneLine} />
      </div>
    );
  }

  if (message.kind === "shell") {
    return (
      <WithInspect message={message} onOpenDetail={onOpenDetail}>
        <div data-message-id={message.id}>
          <ShellBlock
            command={message.command}
            output={message.output}
            done={message.done}
            ok={message.ok}
          />
        </div>
      </WithInspect>
    );
  }

  if (message.kind === "recovered") {
    const reclaimed =
      message.reclaimed > 0 ? ` · ~${fmtTokens(estimateTokens(message.reclaimed))} reclaimed` : "";
    return (
      <div className="pl-3.5">
        <ToneAlert tone="yellow" icon={RotateCw} title="context full">
          {message.detail}
          {reclaimed} · retrying
        </ToneAlert>
      </div>
    );
  }

  if (message.kind === "continued") {
    // A QUIET breadcrumb (02.17): the loop auto-continued past the adaptive step budget because there
    // was context headroom and progress. Deliberately understated muted text - NOT the alarming
    // step_backstop pause card (which renders only on a genuine terminating stop).
    return (
      <div className="flex items-center gap-1.5 pl-3.5 text-label tracking-wide text-muted-foreground/70">
        <CornerDownRight className="size-3 shrink-0" />
        continued at step {message.steps} · {(message.pressure * 100).toFixed(1)}% context, room
        left
      </div>
    );
  }

  if (message.kind === "modelSwitch") {
    // A quiet inline breadcrumb (09.1): the turn changed model and/or reasoning at a step boundary. Each
    // side shows `model (reasoning)`, so a reasoning-only change reads `X (high) -> X (medium)`; a blocked
    // larger->smaller switch shows the guard's reason instead of a delta. Understated like the checkpoint
    // breadcrumb, not an alarming card.
    return (
      <div className="flex items-center gap-1.5 pl-3.5 text-label tracking-wide text-muted-foreground/70">
        <ArrowLeftRight className="size-3 shrink-0" />
        {message.outcome === "blocked"
          ? `switch to ${formatSwitchEndpoint(message.to)} blocked${message.reason ? ` · ${message.reason}` : ""}`
          : `model ${formatSwitchEndpoint(message.from)} -> ${formatSwitchEndpoint(message.to)}`}
      </div>
    );
  }

  if (message.kind === "guardrail") {
    // A quiet, REDACTED advisory (plan 07): the loop flagged a repeating tool path. It shows only the
    // tool, the reason, and the repeat count - never the arguments, output, or fingerprints (D-005).
    // Deliberately understated muted text, like the checkpoint breadcrumb, not an alarming card.
    const reason = message.reason === "repeated_failure" ? "repeated failure" : "no progress";
    const blocked = message.action === "block" || message.action === "halt";
    return (
      <div className="flex items-center gap-1.5 pl-3.5 text-label tracking-wide text-muted-foreground/70">
        <ShieldAlert className="size-3 shrink-0" />
        guardrail · {message.tool} · {reason} ×{message.count}
        {blocked ? " · blocked" : ""}
      </div>
    );
  }

  if (message.kind === "reconnecting") {
    return (
      <div className="pl-3.5">
        <ToneAlert tone="blue" icon={RotateCw} title="connection dropped">
          {message.detail} · reconnecting (attempt {message.attempt}/
          {message.maxAttempts ?? LEGACY_RECONNECT_ATTEMPTS})
        </ToneAlert>
      </div>
    );
  }

  if (message.kind === "compacting") {
    return <CompactingBar tokens={message.tokens} budget={message.budget} />;
  }

  if (message.kind === "delegation") {
    const running = message.status === "running";
    const failed = message.status === "failed";
    const isBackground = message.mode === "background";
    const tone = failed ? "text-smui-red" : running ? "text-smui-purple" : "text-smui-green";
    const verb = running
      ? isBackground
        ? "running in background…"
        : "delegating…"
      : failed
        ? "delegation failed"
        : "delegated";
    return (
      <div className="pl-3.5">
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
      </div>
    );
  }

  const thinking =
    message.kind === "assistant" && showThinking && message.thinking ? message.thinking : null;

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
    return (
      <div className="flex flex-col gap-3 pl-3.5">
        {thinking ? (
          <ThinkingMessage content={thinking} />
        ) : (
          <WorkingIndicator label={message.warm ? "thinking" : `loading ${message.model}`} />
        )}
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
      <UserMessage
        id={message.id}
        text={message.text}
        artifacts={message.artifacts}
        pastes={message.pastes}
        onOpenArtifact={onOpenArtifact}
      />
    );
  }

  return (
    <div data-message-id={message.id} className="flex flex-col gap-3 pl-3.5">
      {thinking ? <ThinkingMessage content={thinking} /> : null}
      {anomalyNote ?? (message.text ? <MarkdownBody text={message.text} /> : null)}
      {overflowNote}
      {errorNote}
      {cancelledNote}
      {interruptedNote}
      {noReplyNote}
      {stepLimitNote}
      {metaItems ? <MessageMeta items={metaItems} /> : null}
    </div>
  );
}
