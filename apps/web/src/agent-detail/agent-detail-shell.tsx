import { useBoolean } from "ahooks";
import { ChevronDown, Waypoints } from "lucide-react";
import { useEffect, useRef } from "react";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import { BackToChat } from "@/components/panel/back-to-chat";
import { cn } from "@/lib/utils";
import { atBottomOf } from "@/scroll";
import { type TranscriptRow, transcriptRowKey } from "@/transcript-rows";

/**
 * Responsible for: the presentational INLINE-AGENT DETAIL takeover (plan 09.4 M6) - the center-column
 * surface that replaces the transcript to show a delegated child's OWN transcript, with the shared
 * upper-left back button (owns Escape + auto-focus, like the tool-detail takeover) and a header naming
 * the agent. It renders the child's rows through the SAME `TranscriptRowView` the main transcript uses,
 * so a subagent's turns read identically; the list is non-virtualized because one child's transcript is
 * bounded (a single delegated task), so the virtualizer's measured-rect machinery would be overkill.
 *
 * Not for: binding the child session's live stream (that's `LiveAgentDetail`), deciding row content
 * (`toTranscript` / `buildTranscriptRows` own that), or any send/compose affordance - the detail is
 * READ-ONLY (the child runs on its own; this is only a window into it, D-003).
 */
export function AgentDetailShell({
  agent,
  rows,
  onBack,
  onOpenPath,
  replayed = true,
  revision,
  className,
}: {
  /** The child agent's name, for the header; absent while it is still being resolved. */
  readonly agent?: string;
  readonly rows: readonly TranscriptRow[];
  readonly onBack: () => void;
  /** Opens a file path from a child tool row in the editor; a no-op is fine for read-only surfaces. */
  readonly onOpenPath: (path: string) => void;
  /** False while the child session's log is still replaying, so the empty state isn't shown prematurely. */
  readonly replayed?: boolean;
  /** A monotonic signal (the live wrapper passes the child's event count) that also advances on a
   *  STREAMING delta within the last row, so auto-scroll re-pins as an answer grows, not only on new
   *  rows; falls back to the row count in stories/tests. */
  readonly revision?: number;
  readonly className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, { set: setAtBottom, setFalse: markAwayFromBottom, setTrue: markAtBottom }] =
    useBoolean(true);

  // Own Escape + focus on mount, matching the tool-detail takeover so the two takeovers behave alike.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onBack();
    }
  };

  // Keep the newest child output in view: a subagent streams to the bottom, so pin there on each
  // update - a new row OR a streaming delta within the last row (tracked by `revision`).
  const pinSignal = revision ?? rows.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin whenever the stream advances.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [pinSignal, atBottom]);

  const updateBottomState = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    setAtBottom(
      atBottomOf({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
      }),
    );
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
    markAtBottom();
  };

  return (
    <section
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Inline agent detail"
      className={cn("flex min-h-0 flex-col bg-background text-foreground outline-none", className)}
    >
      <BackToChat onBack={onBack} />
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 pb-3 text-label uppercase tracking-wider text-muted-foreground">
        <Waypoints className="size-3.5" />
        Inline agent{agent ? <span className="normal-case"> · {agent}</span> : null}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          data-agent-transcript
          onScroll={updateBottomState}
          onWheel={(event) => {
            if (event.deltaY < 0) {
              markAwayFromBottom();
            }
          }}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 py-4"
        >
          {rows.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {replayed
                ? "This agent hasn't produced any output yet."
                : "Loading the agent's transcript…"}
            </div>
          ) : (
            rows.map((row) => (
              <TranscriptRowView
                key={transcriptRowKey(row)}
                row={row}
                showThinking
                onOpenPath={onOpenPath}
                onDoctorRefresh={NOOP}
              />
            ))
          )}
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            className="absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            <ChevronDown className="size-4" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

const NOOP = () => {};
