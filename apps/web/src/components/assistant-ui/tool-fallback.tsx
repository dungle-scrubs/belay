"use client";

import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { statusIcon, type ToolStatus } from "@/components/chat/tool-status";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useElapsedLabel } from "@/hooks/use-elapsed-label";
import { cn } from "@/lib/utils";
import { ANIMATION_DURATION, useCollapsibleDisclosure } from "./use-collapsible-disclosure";

/**
 * The collapsible Args/Result/Error shell for a flat-text tool row (mcp, lsp_*, bash). Adapted from
 * the assistant-ui vendored `tool-fallback`, but decoupled from the assistant-ui runtime (58.6.2 F7):
 * the vendored `useToolCallElapsed` timer and the `ToolFallbackApproval` sub-part - which drove
 * `addResult`/`resume`/`respondToApproval` and only worked inside the assistant-ui runtime, dead in
 * Trevor - are both gone. It now reads Trevor's own `ToolStatus`, drives the running clock from
 * `ToolMessage.startedAt` via the shared `useElapsedLabel` leaf clock (58.6.1 M2), and collapses the
 * result by default so a long `lsp_diagnostics`/`mcp`/`bash` body stays out of the DOM until opened.
 */

/** Trevor's `ToolStatus` (running/done/error) mapped to the assistant-ui lifecycle-icon axis. */
const STATUS_ICON_TYPE = {
  running: "running",
  done: "complete",
  error: "incomplete",
} as const;

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const { ref, open, onOpenChange } = useCollapsibleDisclosure({
    open: controlledOpen,
    defaultOpen,
    onOpenChange: controlledOnOpenChange,
  });

  return (
    <Collapsible
      ref={ref}
      data-slot="tool-fallback-root"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("aui-tool-fallback-root group/tool-fallback-root w-full", className)}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

/** The live elapsed cell, ticking only while running (paused via an undefined `startedAt`). */
function ToolFallbackDuration({
  startedAt,
  running,
  className,
  ...props
}: React.ComponentProps<"span"> & { startedAt?: number; running: boolean }) {
  const label = useElapsedLabel(running ? startedAt : undefined);
  if (!label) {
    return null;
  }

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        "aui-tool-fallback-duration text-muted-foreground text-xs tabular-nums",
        className,
      )}
      {...props}
    >
      {label}
    </span>
  );
}

function ToolFallbackTrigger({
  toolName,
  argsSummary,
  status,
  startedAt,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  /** Bounded one-line arg summary shown beside the name so a collapsed row stays informative. */
  argsSummary?: string;
  status: ToolStatus;
  startedAt?: number;
}) {
  const isRunning = status === "running";
  const isError = status === "error";
  const Icon = statusIcon(STATUS_ICON_TYPE[status]);

  const nameLabel = (
    <>
      <b>{toolName}</b>
      {argsSummary ? <span className="text-muted-foreground">({argsSummary})</span> : null}
    </>
  );

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit items-center gap-2 py-1 text-sm transition-colors",
        className,
      )}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-4 shrink-0",
          isRunning && "animate-spin",
          isError && "text-smui-red",
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className="aui-tool-fallback-trigger-label-wrapper relative inline-block text-start leading-none"
      >
        <span>{nameLabel}</span>
        {isRunning && (
          <span
            aria-hidden
            data-slot="tool-fallback-trigger-shimmer"
            className="aui-tool-fallback-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {nameLabel}
          </span>
        )}
      </span>
      <ToolFallbackDuration startedAt={startedAt} running={isRunning} />
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-out",
        "data-[state=closed]:animate-collapsible-up",
        "data-[state=open]:animate-collapsible-down",
        "data-[state=closed]:fill-mode-forwards",
        "data-[state=closed]:pointer-events-none",
        "data-[state=open]:duration-(--animation-duration)",
        "data-[state=closed]:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-2 ps-6 pt-1 pb-2">{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  argsText?: string;
}) {
  if (!argsText) {
    return null;
  }

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args", className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value bg-muted/50 text-muted-foreground rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {argsText}
      </pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  result?: string;
}) {
  if (!result) {
    return null;
  }

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn("aui-tool-fallback-result", className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-muted-foreground text-xs font-medium">
        Result:
      </p>
      <pre className="aui-tool-fallback-result-content bg-muted/50 text-muted-foreground mt-1 rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {result}
      </pre>
    </div>
  );
}

function ToolFallbackError({
  error,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  error?: string;
}) {
  if (!error) {
    return null;
  }

  // The `error:` result convention (see tool-status) - drop the prefix under the explicit header.
  const reason = error.replace(/^error:\s*/u, "");

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-smui-red font-semibold">Error:</p>
      <pre className="aui-tool-fallback-error-reason text-smui-red mt-1 whitespace-pre-wrap text-xs">
        {reason}
      </pre>
    </div>
  );
}

export interface ToolFallbackProps {
  toolName: string;
  /** Bounded one-line arg summary shown on the (collapsed) trigger beside the tool name. */
  argsSummary?: string;
  /** The full arguments text shown in the expanded Args block. */
  argsText?: string;
  /** The tool's flat-text result; the `error:` convention routes to the Error block instead. */
  result?: string;
  status: ToolStatus;
  /** Ms epoch of `tool.started`; drives the running clock (58.6.1 M2). */
  startedAt?: number;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * A flat-text tool row rendered as a collapsible disclosure: the trigger (icon + `name(args)` +
 * running clock) is always visible; Args, Result, and Error live in the content, unmounted while
 * closed. Collapsed by default (`defaultOpen=false`) so a long body stays out of the DOM until the
 * user opens it. The Result/Error blocks are null-until-complete (F5): while running, only the
 * shimmering trigger shows - no partial result body.
 */
function ToolFallbackImpl({
  toolName,
  argsSummary,
  argsText,
  result,
  status,
  startedAt,
  defaultOpen = false,
  className,
}: ToolFallbackProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isError = status === "error";

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen} className={className}>
      <ToolFallbackTrigger
        toolName={toolName}
        argsSummary={argsSummary}
        status={status}
        startedAt={startedAt}
      />
      <ToolFallbackContent>
        <ToolFallbackArgs argsText={argsText} />
        {isError ? (
          <ToolFallbackError error={result} />
        ) : (
          <ToolFallbackResult result={status === "running" ? undefined : result} />
        )}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}

const ToolFallback = ToolFallbackImpl as typeof ToolFallbackImpl & {
  displayName?: string;
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
};
