import { useBoolean } from "ahooks";
import { ChevronRight, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/markdown";

/** The uppercase transcript heading above each message (you / assistant / …). */
export function MessageHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("text-label tracking-wider uppercase text-muted-foreground", className)}>
      {children}
    </span>
  );
}

/** The dot-separated meta line under a response: model · ctx · tok/s. */
export function MessageMeta({ items, className }: { items: string[]; className?: string }) {
  return (
    <span className={cn("text-label tracking-wider text-muted-foreground/70", className)}>
      {items.join(" · ")}
    </span>
  );
}

/** Animated "working…" placeholder while a turn is starting / streaming silently. */
export function WorkingIndicator({ label = "working" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm italic text-muted-foreground">
      {label}
      <span className="inline-flex items-center gap-0.5">
        <span className="size-1 rounded-full bg-current [animation:smui-pulse-dot_1.4s_ease-in-out_infinite]" />
        <span className="size-1 rounded-full bg-current [animation:smui-pulse-dot_1.4s_ease-in-out_infinite] [animation-delay:160ms]" />
        <span className="size-1 rounded-full bg-current [animation:smui-pulse-dot_1.4s_ease-in-out_infinite] [animation-delay:320ms]" />
      </span>
    </span>
  );
}

type ToolStatus = "running" | "done" | "error";

const TOOL_STATUS_DOT: Record<ToolStatus, string> = {
  running: "bg-smui-yellow animate-pulse",
  done: "bg-smui-green",
  error: "bg-smui-red",
};

/**
 * Generic tool-call row: icon, name(args), and a status dot, with an optional
 * output body. The foundation specific tool renderers build on.
 */
export function ToolCall({
  name,
  args,
  status = "done",
  children,
  className,
}: {
  name: string;
  args?: ReactNode;
  status?: ToolStatus;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-2 text-ui text-muted-foreground">
        <Wrench className="size-3.5 shrink-0 text-smui-frost-3" />
        <code className="text-ui text-foreground">
          {name}
          <span className="text-muted-foreground">({args ?? ""})</span>
        </code>
        <span
          className={cn("ml-auto inline-block size-[5px] rounded-full", TOOL_STATUS_DOT[status])}
        />
      </div>
      {children ? (
        <div className="border-l border-border pl-3 text-sm text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}

// Shared markdown body. Parsing/sanitizing is the app's existing Markdown
// component; .smui-md re-themes its output with SMUI tokens (see index.css).
function MarkdownBody({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <div className={cn("smui-md text-sm", muted ? "text-muted-foreground" : "text-foreground")}>
      <Markdown text={text} muted={muted} />
    </div>
  );
}

/** A prompt from the user, rendered as markdown. */
export function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <MessageHeading>you</MessageHeading>
      <MarkdownBody text={text} />
    </div>
  );
}

/** A model response (markdown), with an optional meta node and streaming label. */
export function AssistantMessage({
  content,
  streaming = false,
  meta,
}: {
  content: string;
  streaming?: boolean;
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <MessageHeading>{streaming ? "assistant · streaming" : "assistant"}</MessageHeading>
      <MarkdownBody text={content} />
      {meta}
    </div>
  );
}

/** The reasoning trace: collapsible, dim + italic markdown. */
export function ThinkingMessage({
  content,
  defaultOpen = true,
}: {
  content: string;
  defaultOpen?: boolean;
}) {
  const [open, { toggle }] = useBoolean(defaultOpen);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={toggle}
        className="flex w-fit cursor-pointer items-center gap-1.5 text-label tracking-wider uppercase text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        thinking
      </button>
      {open ? (
        <div className="border-l border-border pl-3">
          <MarkdownBody text={content} muted />
        </div>
      ) : null}
    </div>
  );
}

/** An immediate slash command the user ran (host lane, not the model). */
export function CommandMessage({ command, args }: { command: string; args?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <MessageHeading>you</MessageHeading>
      <code className="text-sm text-primary">{args ? `${command} ${args}` : command}</code>
    </div>
  );
}

/** The host's output for a slash command: raw text in a bordered surface. */
export function CommandResult({
  command,
  text,
  ok = true,
}: {
  command: string;
  text: string;
  ok?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={cn("text-label tracking-wider text-muted-foreground", !ok && "text-smui-red")}
      >
        {command}
        {ok ? "" : " · failed"}
      </span>
      <pre className="overflow-x-auto whitespace-pre-wrap border border-border bg-smui-surface-1 px-3 py-2.5 text-sm text-foreground">
        {text}
      </pre>
    </div>
  );
}
