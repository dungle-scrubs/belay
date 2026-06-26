import { useBoolean } from "ahooks";
import { ChevronRight, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Markdown } from "@/markdown";
import { ToolSection } from "./tool-section";
import { type ToolStatus, toolStatusColor } from "./tool-status";

export type { ToolStatus } from "./tool-status";

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

/**
 * Generic tool-call row: icon, name(args), with an optional output body. The
 * foundation specific tool renderers build on (diffs, search results, etc.), so
 * making *it* collapsible makes every result-bearing tool call collapsible.
 *
 * With a body, the row is a collapsible trigger (leading chevron) and the body is
 * its content; `defaultOpen` is the single seam a future global "compact" setting
 * drives to collapse every tool call to its one-line header. Body-less rows (read,
 * glob, skill) are already one line, so they render as a plain, non-interactive row
 * with a chevron-width spacer that keeps every name(args) left edge aligned. Status
 * tints the wrench icon.
 */
/**
 * The args text of a tool row rendered as a click target that opens the file in
 * the local editor. A `role="button"` span (not a real `<button>`) so it nests
 * safely inside the collapsible trigger; `stopPropagation` keeps a click from
 * toggling the row open/closed.
 */
export function OpenPathLink({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  const open = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onOpen();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a real <button> can't nest inside the collapsible trigger button; role + keydown keep it keyboard-accessible.
    <span
      role="button"
      tabIndex={0}
      title="Open in editor"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(event);
        }
      }}
      className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
    >
      {children}
    </span>
  );
}

export function ToolCall({
  name,
  args,
  status = "done",
  children,
  defaultOpen = true,
  className,
  onOpenPath,
  border = false,
  sectionTitle,
  sectionMeta,
}: {
  name: string;
  args?: ReactNode;
  status?: ToolStatus;
  children?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  /** When set, the args text becomes a click target that opens the file in the editor. */
  onOpenPath?: () => void;
  /**
   * Wrap the body in a bordered ToolSection box (header + border) instead of letting it sit flat
   * under the row. Off by default: a single body sits flat under the already-collapsible row, so the
   * box (and its second chevron) would be redundant. The seam every result-bearing renderer (diff,
   * output, web-search) shares to box its body when it wants to - the boxing assembly lives here, not
   * in a separate ToolShell wrapper.
   */
  border?: boolean;
  /** Header left/right of the ToolSection box (a file path, a +/- stat); shown only when `border`. */
  sectionTitle?: ReactNode;
  sectionMeta?: ReactNode;
}) {
  const argsNode = onOpenPath ? (
    <OpenPathLink onOpen={onOpenPath}>{args}</OpenPathLink>
  ) : (
    (args ?? "")
  );
  const header = (
    <>
      <Wrench className={cn("size-3.5 shrink-0", toolStatusColor(status, true))} />
      <code className="text-ui text-foreground">
        {name}
        <span className="text-muted-foreground">({argsNode})</span>
      </code>
    </>
  );

  if (!children) {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <div className="flex items-center gap-2 text-ui text-muted-foreground">
          <span className="size-3 shrink-0" aria-hidden />
          {header}
        </div>
      </div>
    );
  }

  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("flex flex-col gap-1", className)}>
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 text-ui text-muted-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {header}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-l border-border pl-3 text-sm text-muted-foreground">
          {border ? (
            <ToolSection title={sectionTitle} meta={sectionMeta}>
              {children}
            </ToolSection>
          ) : (
            children
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
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

/** A prompt from the user: a boxed, left-barred block (no header). */
export function UserMessage({ text }: { text: string }) {
  return (
    <div className="border-l-2 border-primary bg-card px-3 py-2">
      <MarkdownBody text={text} />
    </div>
  );
}

/** A model response (markdown), plain prose with an optional meta node (no header). */
export function AssistantMessage({ content, meta }: { content: string; meta?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
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
          {/* Thinking reads one shade quieter than muted prose - it's scaffolding,
              not the answer. Opacity keeps the left border at full strength. */}
          <div className="opacity-75">
            <MarkdownBody text={content} muted />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A prompt-shell-lane run (D-082): a leading `!` that ran through the host's protected shell path.
 * Rendered as a terminal block - an orange `$ command` prompt line (matching the composer's shell
 * lane), then the output in a monospace pre - visually distinct from the assistant prose, tool cards,
 * and the bordered command-result surface. While the result is pending it shows a "running…" line; a
 * refused/failed command tints the output red.
 */
export function ShellBlock({
  command,
  output,
  done,
  ok = true,
}: {
  command: string;
  output?: string;
  done: boolean;
  ok?: boolean;
}) {
  return (
    <div className="flex flex-col border border-smui-orange/25 bg-smui-orange/[0.05] font-mono text-sm">
      <div className="flex items-start gap-2 border-smui-orange/15 border-b px-3 py-2 text-foreground">
        <span aria-hidden className="shrink-0 select-none text-smui-orange">
          $
        </span>
        <code className="min-w-0 whitespace-pre-wrap break-all">{command}</code>
      </div>
      {!done ? (
        <div className="px-3 py-2 text-muted-foreground italic">running…</div>
      ) : output ? (
        <pre
          className={cn(
            "overflow-x-auto whitespace-pre-wrap px-3 py-2",
            ok ? "text-muted-foreground" : "text-smui-red",
          )}
        >
          {output}
        </pre>
      ) : null}
    </div>
  );
}

/** The host's output for a slash command: raw text in a bordered surface. The command the user typed
 *  is not echoed (it is not listed in the transcript); only this result is shown. */
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
