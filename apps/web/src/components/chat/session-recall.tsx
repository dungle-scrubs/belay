import { type RecallResult, relativeTime } from "@trevor/session";
import { cn } from "@/lib/utils";
import { ToolCall, WorkingIndicator } from "./message";
import type { ToolStatus } from "./tool-status";

/**
 * Renders a `session_recall` tool call (D-044): the distilled findings the model recalled from
 * older project memory, over a compact activity line (sessions/folds/sources searched) and a list
 * of collapsed source rows citing the sessions + turns each came from. Recall is shown VISIBLY in
 * the transcript as a tool result - never hidden reasoning - so the user can see what was searched
 * and where an answer came from. Falls back to a working indicator while running, a neutral note
 * for no-hits/unavailable, and a red message on error; partial searches surface their diagnostics.
 */

interface SessionRecallResultsProps {
  /** The query the model recalled (the tool's `query` argument). */
  query: string;
  /** The decoded recall result, or null while the call is still running. */
  result: RecallResult | null;
  status?: ToolStatus;
  /** Now, for relative timestamps (injectable so stories + tests are deterministic). */
  nowMs?: number;
  defaultOpen?: boolean;
  className?: string;
}

/** A short kind glyph for a source row (keeps row height stable across kinds). */
const KIND_LABEL: Record<RecallResult["sources"][number]["kind"], string> = {
  user: "you",
  assistant: "reply",
  tool: "tool",
  fold: "summary",
};

/** The compact activity line: what recall actually searched and found. */
function activityLine(result: RecallResult): string {
  const a = result.activity;
  return [
    `${a.searchedSessions} session${a.searchedSessions === 1 ? "" : "s"}`,
    `${a.searchedFolds} folded span${a.searchedFolds === 1 ? "" : "s"}`,
    `${a.neighborhoods} source${a.neighborhoods === 1 ? "" : "s"}`,
  ].join(" · ");
}

export function SessionRecallResults({
  query,
  result,
  status = "done",
  nowMs = Date.now(),
  defaultOpen = true,
  className,
}: SessionRecallResultsProps) {
  // Still streaming / no decodable result yet: a working indicator (unless an error already landed).
  if (status === "running" && !result) {
    return (
      <ToolCall
        name="session_recall"
        args={query}
        status="running"
        defaultOpen={defaultOpen}
        className={className}
      >
        <WorkingIndicator label="recalling" />
      </ToolCall>
    );
  }

  if (!result || result.status === "error") {
    const detail = result?.diagnostics.find((d) => d.detail)?.detail ?? "recall failed";
    return (
      <ToolCall
        name="session_recall"
        args={query}
        status="error"
        defaultOpen={defaultOpen}
        className={className}
      >
        <span className="text-sm text-smui-red">Recall failed: {detail}</span>
      </ToolCall>
    );
  }

  const note =
    result.status === "unavailable"
      ? "No earlier project memory to search yet."
      : result.status === "no_hits"
        ? "No earlier project memory matched."
        : result.status === "invalid_filters"
          ? `Invalid recall filters: ${result.diagnostics[0]?.detail ?? "bad filters"}`
          : null;

  const resolvedStatus: ToolStatus = result.status === "invalid_filters" ? "error" : status;

  return (
    <ToolCall
      name="session_recall"
      args={query}
      status={resolvedStatus}
      defaultOpen={defaultOpen}
      className={className}
      sectionTitle={<span className="text-muted-foreground">{activityLine(result)}</span>}
    >
      <section className="flex flex-col gap-2.5" aria-label="session recall result">
        <span className="text-label tracking-wider text-muted-foreground/70">
          {activityLine(result)}
        </span>

        {note ? (
          <span
            className={cn(
              "text-sm italic",
              result.status === "invalid_filters" ? "text-smui-red" : "text-muted-foreground",
            )}
          >
            {note}
          </span>
        ) : null}

        {result.findings.length > 0 ? (
          <section className="flex flex-col gap-1.5" aria-label="recall findings">
            {result.findings.map((finding) => (
              <p key={finding.summary.slice(0, 40)} className="text-sm text-foreground">
                {finding.summary}
              </p>
            ))}
          </section>
        ) : null}

        {result.sources.length > 0 ? (
          <ol className="flex flex-col gap-2" aria-label="recall sources">
            {result.sources.map((source, i) => (
              <li key={source.id} className="flex flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="inline-flex items-baseline gap-1.5 truncate text-sm font-medium text-foreground">
                    <span className="shrink-0 text-label tracking-wider text-smui-frost-3/80">
                      S{i + 1}
                    </span>
                    <span className="truncate">{source.sessionLabel}</span>
                  </span>
                  <span className="shrink-0 text-label tracking-wider text-muted-foreground/70">
                    {KIND_LABEL[source.kind]} · {relativeTime(source.timestamp, nowMs)}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">{source.excerpt}</p>
              </li>
            ))}
          </ol>
        ) : null}

        {result.diagnostics.length > 0 && result.status === "partial" ? (
          <span className="text-xs italic text-smui-yellow/90">
            Partial search: {result.diagnostics.map((d) => d.detail).join("; ")}
          </span>
        ) : null}
      </section>
    </ToolCall>
  );
}
