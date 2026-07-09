import { useEffect, useRef } from "react";
import { LiveScrollSurface } from "@/components/chat/live-scroll-surface";
import { type ToolStatus, toolStatusColor } from "@/components/chat/tool-status";
import { BackToChat } from "@/components/panel/back-to-chat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useScrollFollow } from "@/hooks/use-scroll-follow";
import { cn } from "@/lib/utils";
import { DetailBody } from "./detail-body";
import type { ToolDetailModel } from "./detail-model";

/**
 * The tool detail takeover shell (plan 08 M2): a focused inspection surface that replaces the chat
 * transcript/composer (not a modal/overlay - the sidebars stay visible), with a top-left "Back to chat"
 * arrow and a stable header/status area. The per-tool body is dispatched by {@link DetailBody} (M3/M4);
 * the shell here owns the chrome (back, header, status, Escape) that is identical across every tool.
 *
 * Escape returns to chat: the view is a frontmost surface, so the global Escape is already suppressed
 * (escapeAction's modalOpen guard), and this owns Escape locally. It auto-focuses on mount so Escape +
 * scrolling work immediately; the App restores focus to the source transcript row on close (M5).
 */
export function ToolDetailView({
  model,
  onBack,
  action,
  onOpenPath,
  className,
}: {
  readonly model: ToolDetailModel;
  readonly onBack: () => void;
  readonly action?: {
    readonly label: string;
    readonly onClick: () => void;
  };
  /** Opens a file path in the editor (read/write/edit/multi_edit detail), when the host can. */
  readonly onOpenPath?: (path: string) => void;
  readonly className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const scroll = useScrollFollow(1);
  const revision = `${model.id}:${model.status}:${model.output?.length ?? 0}:${model.error?.length ?? 0}`;
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label={`Tool detail: ${model.toolName}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onBack();
        }
      }}
      className={cn(
        "@container flex min-h-0 flex-col bg-background text-foreground outline-none",
        className,
      )}
    >
      <BackToChat onBack={onBack} />

      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="font-mono text-base font-medium">{model.toolName}</h2>
        <StatusPill status={model.status} aborted={model.aborted} />
        {action ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={action.onClick}
            className="ml-auto"
          >
            {action.label}
          </Button>
        ) : null}
      </header>

      <LiveScrollSurface
        className="gap-4 px-4 py-3"
        revision={revision}
        scroll={scroll}
        surfaceLabel="tool detail"
        viewportDataAttribute="data-tool-detail-scroll"
      >
        <div data-live-scroll-item data-live-scroll-item-id={model.id}>
          <DetailBody model={model} onOpenPath={onOpenPath} />
        </div>
      </LiveScrollSurface>
    </section>
  );
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: "Running",
  done: "Done",
  error: "Error",
};

/** The status chip: the shared Badge for the pill chrome, colored from the same toolStatusColor map the
 *  transcript wrench uses (so the two can't drift). */
function StatusPill({
  status,
  aborted,
}: {
  readonly status: ToolStatus;
  readonly aborted: boolean;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("text-label tracking-wider uppercase", toolStatusColor(status))}
    >
      {aborted ? "Aborted" : STATUS_LABEL[status]}
    </Badge>
  );
}
