import { relativeTime } from "@trevor/session";
import { AlertTriangle, Loader2, Play, RotateCcw } from "lucide-react";
import { RELATIVE_TIME_TICK_MS, useNow } from "@/hooks/use-now";

export type ResumeHostRowState =
  | {
      readonly phase: "manual";
      readonly updatedAt: string;
      readonly onResume: () => void;
      /** Fixed wall clock for deterministic stories/tests; omitted (the live default), the row ticks
       *  its OWN leaf clock (Tier 2.3). */
      readonly nowMs?: number;
    }
  | { readonly phase: "starting"; readonly label: string }
  | { readonly phase: "failed"; readonly error: string; readonly onRetry: () => void }
  | {
      readonly phase: "unlaunchable";
      readonly updatedAt: string;
      readonly nowMs?: number;
    };

export function ResumeHostRow({ state }: { readonly state: ResumeHostRowState }) {
  const showsRecency = state.phase === "manual" || state.phase === "unlaunchable";
  const providedNow = showsRecency ? state.nowMs : undefined;
  // The row's own relative-time clock (Tier 2.3), armed only for the phases that render recency text.
  const clockNow = useNow(RELATIVE_TIME_TICK_MS, {
    enabled: showsRecency && providedNow === undefined,
  });
  const detail = showsRecency
    ? `Last active ${relativeTime(state.updatedAt, providedNow ?? clockNow)}`
    : null;

  return (
    <div
      data-resume-host-row
      className="mb-2 flex items-center gap-3 rounded border border-border bg-card/60 px-3 py-2 text-ui"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded bg-smui-surface-sunken text-muted-foreground">
        {state.phase === "starting" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : state.phase === "failed" || state.phase === "unlaunchable" ? (
          <AlertTriangle className="size-3.5" />
        ) : (
          <Play className="size-3.5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-foreground">
          {state.phase === "manual"
            ? "Resume this conversation"
            : state.phase === "starting"
              ? state.label
              : state.phase === "failed"
                ? state.error
                : "No launch root is available"}
        </span>
        {detail ? (
          <span className="block text-label tracking-wider text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {state.phase === "manual" ? (
        <button
          type="button"
          onClick={state.onResume}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-foreground hover:bg-accent"
        >
          <Play className="size-3" />
          Resume
        </button>
      ) : state.phase === "failed" ? (
        <button
          type="button"
          onClick={state.onRetry}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-foreground hover:bg-accent"
        >
          <RotateCcw className="size-3" />
          Retry
        </button>
      ) : null}
    </div>
  );
}
