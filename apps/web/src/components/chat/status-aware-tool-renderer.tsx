import type { ReactNode } from "react";
import { toolActionLabel } from "@/action-label";
import { ActionShimmer } from "./action-shimmer";
import { ToolCall } from "./message";
import type { ToolStatus } from "./tool-status";

interface StatusAwareToolRendererProps {
  name: string;
  args?: ReactNode;
  status?: ToolStatus;
  error?: ReactNode;
  running?: boolean;
  /**
   * The running-status label. Production renderers pass this explicitly, built from their own
   * already-typed target (query/url/path) via `toolActionLabelForTarget` (plan 31), so the shimmer
   * names the specific thing in flight ("reading apps/web/src/app.tsx") rather than a bare verb.
   * Falls back to the centralized `toolActionLabel(name)` bare verb when omitted - the safety net
   * for a caller that has no typed target to offer.
   */
  runningLabel?: string;
  /**
   * Ms epoch of the tool's `tool.started` (from `ToolMessage.startedAt`). When present on the running
   * branch it feeds the shimmer's live elapsed timer, so a slow tool ("reading… (12s)") is
   * distinguishable from a stuck one. Absent for a legacy log with a malformed timestamp, in which
   * case the shimmer simply renders without the elapsed meta (plan 58.6.1 M2).
   */
  startedAt?: number;
  defaultOpen?: boolean;
  border?: boolean;
  className?: string;
  sectionTitle?: ReactNode;
  sectionMeta?: ReactNode;
  onOpenPath?: () => void;
  renderBody?: () => ReactNode;
}

export function StatusAwareToolRenderer({
  name,
  args,
  status = "done",
  error,
  running = false,
  runningLabel,
  startedAt,
  defaultOpen = true,
  border = false,
  className,
  sectionTitle,
  sectionMeta,
  onOpenPath,
  renderBody,
}: StatusAwareToolRendererProps) {
  if (error) {
    return (
      <ToolCall
        name={name}
        args={args}
        status="error"
        defaultOpen={defaultOpen}
        className={className}
        onOpenPath={onOpenPath}
      >
        {typeof error === "string" ? <span className="text-sm text-smui-red">{error}</span> : error}
      </ToolCall>
    );
  }

  if (running) {
    return (
      <ToolCall
        name={name}
        args={args}
        status="running"
        defaultOpen={defaultOpen}
        className={className}
        onOpenPath={onOpenPath}
      >
        <ActionShimmer label={runningLabel ?? toolActionLabel(name)} startedAt={startedAt} />
      </ToolCall>
    );
  }

  return (
    <ToolCall
      name={name}
      args={args}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
      onOpenPath={onOpenPath}
      border={border}
      sectionTitle={sectionTitle}
      sectionMeta={sectionMeta}
    >
      {renderBody?.()}
    </ToolCall>
  );
}
