import { useEffect, useRef } from "react";
import type { ToolStatus } from "@/components/chat/tool-status";
import { BackToChat } from "@/components/panel/back-to-chat";
import { cn } from "@/lib/utils";
import type { ToolDetailModel } from "./detail-model";

/**
 * The tool detail takeover shell (plan 08 M2): a focused inspection surface that replaces the chat
 * transcript/composer (not a modal/overlay - the sidebars stay visible), with a top-left "Back to chat"
 * arrow and a stable header/status area. M2 is the GENERIC shell over any {@link ToolDetailModel}
 * (arguments, status, output, error); per-tool richer bodies land in M3/M4.
 *
 * Escape returns to chat: the view is a frontmost surface, so the global Escape is already suppressed
 * (escapeAction's modalOpen guard), and this owns Escape locally. It auto-focuses on mount so Escape +
 * scrolling work immediately; the App restores focus to the source transcript row on close (M5).
 */
export function ToolDetailView({
  model,
  onBack,
  className,
}: {
  readonly model: ToolDetailModel;
  readonly onBack: () => void;
  readonly className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
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
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        <DetailSection title="Arguments">
          <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {model.args || "(none)"}
          </pre>
        </DetailSection>

        {model.error ? (
          <DetailSection title="Error">
            <pre className="overflow-x-auto rounded bg-smui-red/10 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-smui-red">
              {model.error}
            </pre>
          </DetailSection>
        ) : null}

        <DetailSection title="Output">
          {model.output ? (
            <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
              {model.output}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              {model.status === "running" ? "Running - no output yet." : "No output."}
            </p>
          )}
        </DetailSection>
      </div>
    </section>
  );
}

const STATUS_PILL: Record<ToolStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-smui-yellow/15 text-smui-yellow" },
  done: { label: "Done", className: "bg-smui-frost-3/15 text-smui-frost-3" },
  error: { label: "Error", className: "bg-smui-red/15 text-smui-red" },
};

function StatusPill({
  status,
  aborted,
}: {
  readonly status: ToolStatus;
  readonly aborted: boolean;
}) {
  const pill = STATUS_PILL[status];
  return (
    <span
      className={cn("rounded-full px-2 py-0.5 text-label tracking-wider uppercase", pill.className)}
    >
      {aborted ? "Aborted" : pill.label}
    </span>
  );
}

function DetailSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-label tracking-wider uppercase text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
