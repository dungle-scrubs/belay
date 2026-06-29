import { estimateTokens, isContextOverflowText } from "@trevor/session";
import { CircleX, PanelRight, RotateCw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { CompactingBar } from "@/components/chat/compacting-bar";
import { type ConcurrentTool, ConcurrentTools } from "@/components/chat/concurrent-tools";
import { DoctorResult } from "@/components/chat/doctor/doctor-result";
import { MarkdownBody } from "@/components/chat/markdown-body";
import {
  CommandResult,
  MessageMeta,
  ShellBlock,
  ThinkingMessage,
  WorkingIndicator,
} from "@/components/chat/message";
import { MessageAttachments } from "@/components/chat/message-attachments";
import { QuestionTranscriptItem } from "@/components/chat/question-item";
import { ToneAlert } from "@/components/chat/tone-alert";
import { parseToolArgs, ToolRenderer } from "@/components/chat/tool-message";
import { toolMessageStatus } from "@/components/chat/tool-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { fmtCtx, fmtTokens, toolSummary } from "../../derive";
import type { ToolMessage as ToolMessageData } from "../../transcript";
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
  readonly onDoctorRefresh: () => void;
  /** Render resolved-question rows as a single compact line (D-003). Off by default; a future compact
   *  transcript mode flips it on. */
  readonly questionsOneLine?: boolean;
}

export function TranscriptRowView({
  row,
  showThinking,
  onOpenPath,
  onDoctorRefresh,
  questionsOneLine = false,
}: TranscriptRowViewProps) {
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
    return <ToolRenderer message={message} className="pl-3.5" onOpenPath={onOpenPath} />;
  }

  if (message.kind === "result") {
    return (
      <div className="pl-3.5">
        {message.command === "/doctor" ? (
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
      <ShellBlock
        command={message.command}
        output={message.output}
        done={message.done}
        ok={message.ok}
      />
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

  if (message.kind === "reconnecting") {
    return (
      <div className="pl-3.5">
        <ToneAlert tone="blue" icon={RotateCw} title="connection dropped">
          {message.detail} · reconnecting (attempt {message.attempt}/3)
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

  let stepLimitNote: ReactNode = null;
  if (message.kind === "assistant") {
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
      <div
        data-message-id={message.id}
        className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2"
      >
        {message.text ? <MarkdownBody text={message.text} /> : null}
        {message.artifacts.length ? <MessageAttachments artifacts={message.artifacts} /> : null}
      </div>
    );
  }

  return (
    <div data-message-id={message.id} className="flex flex-col gap-3 pl-3.5">
      {thinking ? <ThinkingMessage content={thinking} /> : null}
      {message.text ? <MarkdownBody text={message.text} /> : null}
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
