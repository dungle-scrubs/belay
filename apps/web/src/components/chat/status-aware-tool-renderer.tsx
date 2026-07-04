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
   * Overrides the running-status label. Defaults to the centralized `toolActionLabel(name)` verb
   * (plan 31), so a renderer only sets this when its tool name isn't in the shared vocabulary map.
   */
  runningLabel?: string;
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
        <ActionShimmer label={runningLabel ?? toolActionLabel(name)} />
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
