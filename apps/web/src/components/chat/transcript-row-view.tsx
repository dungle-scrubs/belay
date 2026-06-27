import {
  Archive,
  CircleX,
  PanelRight,
  Play,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { CompactingBar } from "@/components/chat/compacting-bar";
import { type ConcurrentTool, ConcurrentTools } from "@/components/chat/concurrent-tools";
import { DoctorResult } from "@/components/chat/doctor/doctor-result";
import {
  CommandResult,
  MessageMeta,
  ShellBlock,
  ThinkingMessage,
  WorkingIndicator,
} from "@/components/chat/message";
import { MessageAttachments } from "@/components/chat/message-attachments";
import { ToolMessage } from "@/components/chat/tool-message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArtifactThumb } from "../../ArtifactThumb";
import { fmtCtx, fmtTokens, isOverflowError } from "../../derive";
import { Markdown } from "../../markdown";
import type { QueuedPrompt } from "../../send-queue";
import type { ToolMessage as ToolMessageData } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

function Md({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <div className={cn("smui-md text-sm", muted ? "text-muted-foreground" : "text-foreground")}>
      <Markdown text={text} muted={muted} />
    </div>
  );
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

export type StopAction = "continue" | "compress" | "retry" | "cancel";

function StopControls({ onAction }: { readonly onAction: (action: StopAction) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <Button type="button" size="xs" variant="secondary" onClick={() => onAction("continue")}>
        <Play className="size-3" />
        Continue
      </Button>
      <Button type="button" size="xs" variant="outline" onClick={() => onAction("compress")}>
        <Archive className="size-3" />
        Compress
      </Button>
      <Button type="button" size="xs" variant="outline" onClick={() => onAction("retry")}>
        <RefreshCw className="size-3" />
        Retry
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => onAction("cancel")}>
        <CircleX className="size-3" />
        Cancel
      </Button>
    </div>
  );
}

function QueueRow({ queue }: { queue: readonly QueuedPrompt[] }) {
  return (
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
  );
}

export interface TranscriptRowViewProps {
  readonly row: TranscriptRow;
  readonly showThinking: boolean;
  readonly toConcurrentTool: (tool: ToolMessageData) => ConcurrentTool;
  readonly onOpenPath: (path: string) => void;
  readonly onDoctorRefresh: () => void;
  readonly onStopAction: (action: StopAction) => void;
}

export function TranscriptRowView({
  row,
  showThinking,
  toConcurrentTool,
  onOpenPath,
  onDoctorRefresh,
  onStopAction,
}: TranscriptRowViewProps) {
  if (row.kind === "tool_batch") {
    return (
      <div className="pl-3.5">
        <ConcurrentTools tools={row.tools.map(toConcurrentTool)} />
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

  if (row.kind === "queue") {
    return <QueueRow queue={row.queue} />;
  }

  const message = row.message;
  if (message.kind === "tool") {
    return <ToolMessage message={message} className="pl-3.5" onOpenPath={onOpenPath} />;
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
      message.reclaimed > 0 ? ` · ~${fmtTokens(Math.round(message.reclaimed / 4))} reclaimed` : "";
    return (
      <div className="pl-3.5">
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
    return (
      <div className="pl-3.5">
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
    message.kind === "assistant" && showThinking && message.thinking ? message.thinking : null;

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
        <AlertTitle>{isOverflowError(message.error) ? "context overflow" : "error"}</AlertTitle>
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
      <Alert className="border-smui-yellow/25 bg-smui-yellow/[0.04] [&>svg]:text-smui-yellow">
        <TriangleAlert className="h-3.5 w-3.5" />
        <AlertTitle className="text-smui-yellow">no reply</AlertTitle>
        <AlertDescription>
          The model ended the turn without a reply. Try again or rephrase.
        </AlertDescription>
      </Alert>
    ) : null;

  const stepLimitNote =
    message.kind === "assistant" && message.stop ? (
      <Alert className="border-smui-yellow/25 bg-smui-yellow/[0.04] [&>svg]:text-smui-yellow">
        <TriangleAlert className="h-3.5 w-3.5" />
        <AlertTitle className="text-smui-yellow">{stopTitle(message.stop.cause)}</AlertTitle>
        <AlertDescription className="break-words">
          <div>{message.stop.summary.slice(0, 240)}</div>
          <StopControls onAction={onStopAction} />
        </AlertDescription>
      </Alert>
    ) : message.kind === "assistant" && message.stepLimit ? (
      <div className="text-label text-muted-foreground">
        legacy step budget reached after {message.stepLimit} steps
      </div>
    ) : null;

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
        {message.text ? <Md text={message.text} /> : null}
        {message.artifacts.length ? <MessageAttachments artifacts={message.artifacts} /> : null}
      </div>
    );
  }

  return (
    <div data-message-id={message.id} className="flex flex-col gap-3 pl-3.5">
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
}
