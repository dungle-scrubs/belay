import { relativeTime, type SessionSummary } from "@trevor/session";
import { GitBranch } from "lucide-react";
import { BackToChat } from "@/components/panel/back-to-chat";
import { TakeoverSurface } from "@/components/panel/takeover-surface";
import { RELATIVE_TIME_TICK_MS, useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

/**
 * Parent-owned tangent discovery (plan 37, M7): a center-column takeover listing THIS session's tangents,
 * each with its source-quote snippet, status, recency, and an open action. It is deliberately separate
 * from the ordinary session sidebar and resume chooser (tangents are excluded from those via
 * `activeSessions`), so a scoped side thread is found from its parent, not the global session list.
 * Presentational: the caller supplies the already-filtered tangents (`tangentsOf`) and the open/back
 * actions.
 */
export interface TangentDiscoveryProps {
  readonly tangents: readonly SessionSummary[];
  /** Wall clock for the recency labels. Pass a fixed value for deterministic stories/tests; omitted
   *  (the live default), the list ticks its OWN leaf clock (Tier 2.3). */
  readonly nowMs?: number;
  readonly onOpen: (tangent: SessionSummary) => void;
  readonly onBack: () => void;
  readonly className?: string;
}

function statusFor(summary: SessionSummary): { label: string; tone: string } {
  if (summary.activity === "running") {
    return { label: "running", tone: "text-smui-green" };
  }
  if (summary.host === "live") {
    return { label: "host ready", tone: "text-muted-foreground" };
  }
  if (summary.activity === "settled") {
    return { label: "idle", tone: "text-muted-foreground/70" };
  }
  return { label: "new", tone: "text-muted-foreground/70" };
}

export function TangentDiscovery({
  tangents,
  nowMs,
  onOpen,
  onBack,
  className,
}: TangentDiscoveryProps) {
  // The list's own relative-time clock (Tier 2.3); a provided nowMs pauses it for determinism.
  const clockNow = useNow(RELATIVE_TIME_TICK_MS, { enabled: nowMs === undefined });
  const rowNowMs = nowMs ?? clockNow;
  return (
    <TakeoverSurface
      label="Tangents"
      onBack={onBack}
      className={cn("bg-background text-foreground", className)}
    >
      <BackToChat onBack={onBack} />
      <div className="shrink-0 px-3 pb-2">
        <h2 className="text-sm font-medium text-foreground">Tangents from this session</h2>
        <p className="text-xs text-muted-foreground">
          Isolated side conversations you branched from a selection.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {tangents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <GitBranch className="size-5 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No tangents yet.</p>
            <p className="text-xs text-muted-foreground/70">
              Select text in a message and choose Tangent to start one.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {tangents.map((tangent) => {
              const status = statusFor(tangent);
              const quote = tangent.tangentOf?.quote ?? tangent.title;
              return (
                <li key={tangent.sessionId}>
                  <button
                    type="button"
                    onClick={() => onOpen(tangent)}
                    className="flex w-full flex-col gap-1 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/50"
                  >
                    <span className="line-clamp-2 text-sm text-foreground">“{quote}”</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={status.tone}>{status.label}</span>
                      <span aria-hidden="true">·</span>
                      <span>{relativeTime(tangent.updatedAt, rowNowMs)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </TakeoverSurface>
  );
}
