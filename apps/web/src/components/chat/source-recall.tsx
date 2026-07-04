import {
  relativeTime,
  type SourceRecallIndexStatus,
  type SourceRecallRefreshResult,
  type SourceRecallResult,
  type SourceRecallResultItem,
} from "@trevor/session";
import { ArrowUpRight } from "lucide-react";
import { toolActionLabelForTarget } from "@/action-label";
import { cn } from "@/lib/utils";
import { StatusAwareToolRenderer } from "./status-aware-tool-renderer";
import type { ToolStatus } from "./tool-status";

/**
 * Renders the indexed source-recall tools (plan 38 M9): `source_recall` query results,
 * `source_index_status`, and `source_index_refresh`. Source recall is shown VISIBLY in the
 * transcript as a bounded, CITED tool result - file path + line range + symbol + snippet per
 * candidate, over a provider/freshness meta line - never hidden injected context. Each state is
 * covered: running, ok, stale (a yellow freshness flag), no results, unready, unavailable, and
 * error. This is deliberately SEPARATE from session-recall rendering (they are different contracts,
 * D-001), sharing only generic tokens - not the session-recall row shape.
 */

interface SourceRecallResultsProps {
  /** The conceptual query the model searched (the tool's `query` argument). */
  query: string;
  /** The decoded query result, or null while the call is still running. */
  result: SourceRecallResult | null;
  status?: ToolStatus;
  /** Now, for relative freshness (injectable so stories + tests are deterministic). */
  nowMs?: number;
  /** Opens a cited file in the editor. */
  onOpenPath?: (path: string) => void;
  defaultOpen?: boolean;
  className?: string;
}

/** A compact provider/latency/freshness meta line under the query row. */
function metaLine(result: SourceRecallResult, nowMs: number): string {
  const parts = [
    result.providerId ?? result.providerKind ?? "source recall",
    `${result.results.length} result${result.results.length === 1 ? "" : "s"}`,
  ];
  if (result.latencyMs != null) {
    parts.push(`${result.latencyMs}ms`);
  }
  const indexedAt = result.freshness?.indexedAt;
  if (indexedAt) {
    parts.push(`indexed ${relativeTime(indexedAt, nowMs)}`);
  }
  return parts.join(" · ");
}

/** The neutral note for a non-ok, non-error status (or null when there is nothing to say). */
function statusNote(result: SourceRecallResult): string | null {
  switch (result.status) {
    case "unavailable":
      return result.diagnostics[0]?.detail ?? "No source-recall provider is available.";
    case "unready":
      return result.diagnostics[0]?.detail ?? "The index is not ready yet.";
    case "no_results":
      return "No indexed code matched.";
    default:
      return null;
  }
}

/** One cited candidate row: a clickable file path + line range, a symbol chip, and a clamped snippet. */
function ResultRow({
  item,
  index,
  onOpenPath,
}: {
  item: SourceRecallResultItem;
  index: number;
  onOpenPath?: (path: string) => void;
}) {
  const lines =
    item.startLine === item.endLine ? `L${item.startLine}` : `L${item.startLine}-${item.endLine}`;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="inline-flex items-baseline gap-1.5 truncate text-sm font-medium text-foreground">
          <span className="shrink-0 text-label tracking-wider text-smui-frost-3/80">
            R{index + 1}
          </span>
          {onOpenPath ? (
            <button
              type="button"
              onClick={() => onOpenPath(item.filePath)}
              className="group inline-flex items-baseline gap-1 truncate text-left hover:text-smui-frost-3 hover:underline"
            >
              <span className="truncate">{item.filePath}</span>
              <ArrowUpRight className="size-3 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ) : (
            <span className="truncate">{item.filePath}</span>
          )}
        </span>
        <span className="shrink-0 text-label tracking-wider text-muted-foreground/70">
          {lines}
          {item.symbolName ? ` · ${item.symbolName}` : ""}
        </span>
      </div>
      {item.snippet ? (
        <pre className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {item.snippet}
        </pre>
      ) : null}
    </li>
  );
}

export function SourceRecallResults({
  query,
  result,
  status = "done",
  nowMs = Date.now(),
  onOpenPath,
  defaultOpen = true,
  className,
}: SourceRecallResultsProps) {
  const error =
    status === "running" && !result
      ? null
      : !result || result.status === "error"
        ? `Source recall failed: ${result?.diagnostics.find((d) => d.detail)?.detail ?? "search failed"}`
        : result.status === "invalid_request"
          ? `Invalid source-recall request: ${result.diagnostics[0]?.detail ?? "bad request"}`
          : null;

  if (error || !result) {
    return (
      <StatusAwareToolRenderer
        name="source_recall"
        args={query}
        status={status}
        error={error}
        running={status === "running" && !result}
        runningLabel={toolActionLabelForTarget("source_recall", query)}
        defaultOpen={defaultOpen}
        className={className}
      />
    );
  }

  const note = statusNote(result);

  return (
    <StatusAwareToolRenderer
      name="source_recall"
      args={query}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
      sectionTitle={<span className="text-muted-foreground">{metaLine(result, nowMs)}</span>}
      renderBody={() => (
        <section className="flex flex-col gap-2.5" aria-label="source recall result">
          <span className="text-label tracking-wider text-muted-foreground/70">
            {metaLine(result, nowMs)}
          </span>

          {result.freshness?.stale ? (
            <span className="text-xs italic text-smui-yellow/90">
              This index is stale - run source_index_refresh for current results.
            </span>
          ) : null}

          {note ? <span className="text-sm italic text-muted-foreground">{note}</span> : null}

          {result.results.length > 0 ? (
            <ol className="flex flex-col gap-2" aria-label="source recall candidates">
              {result.results.map((item, i) => (
                <ResultRow
                  key={`${item.filePath}:${item.startLine}:${item.symbolName}`}
                  item={item}
                  index={i}
                  onOpenPath={onOpenPath}
                />
              ))}
            </ol>
          ) : null}

          {result.capped ? (
            <span className="text-label tracking-wider text-muted-foreground/60">
              Showing the top candidates - narrow the query for more precise hits.
            </span>
          ) : null}
        </section>
      )}
    />
  );
}

interface SourceRecallStatusProps {
  result: SourceRecallIndexStatus | null;
  status?: ToolStatus;
  nowMs?: number;
  defaultOpen?: boolean;
  className?: string;
}

const READINESS_TONE: Record<string, string> = {
  ready: "text-smui-green",
  stale: "text-smui-yellow",
  indexing: "text-smui-frost-3",
  unready: "text-muted-foreground",
  unreachable: "text-smui-red",
  unconfigured: "text-muted-foreground",
};

export function SourceRecallStatus({
  result,
  status = "done",
  nowMs = Date.now(),
  defaultOpen = true,
  className,
}: SourceRecallStatusProps) {
  if (status === "running" && !result) {
    return (
      <StatusAwareToolRenderer
        name="source_index_status"
        status={status}
        running
        runningLabel="checking the index"
        defaultOpen={defaultOpen}
        className={className}
      />
    );
  }

  const unavailable = !result || result.status === "unavailable" || result.status === "error";
  const meta = result
    ? `${result.providerId ?? "no provider"}${
        result.capabilities.length > 0 ? ` · ${result.capabilities.join(", ")}` : ""
      }`
    : "";

  return (
    <StatusAwareToolRenderer
      name="source_index_status"
      status={unavailable ? "error" : status}
      defaultOpen={defaultOpen}
      className={className}
      sectionTitle={<span className="text-muted-foreground">{meta}</span>}
      renderBody={() => (
        <section className="flex flex-col gap-2" aria-label="source index status">
          {meta ? (
            <span className="text-label tracking-wider text-muted-foreground/70">{meta}</span>
          ) : null}
          {!result || result.repos.length === 0 ? (
            <span className="text-sm italic text-muted-foreground">
              {result?.diagnostics[0]?.detail ?? "No indexed source provider is configured."}
            </span>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {result.repos.map((repo) => (
                <li key={repo.name} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-medium text-foreground">{repo.name}</span>
                  <span className="inline-flex shrink-0 items-baseline gap-2 text-label tracking-wider">
                    <span className={cn(READINESS_TONE[repo.readiness] ?? "text-muted-foreground")}>
                      {repo.readiness}
                    </span>
                    {repo.freshness.indexedAt ? (
                      <span className="text-muted-foreground/70">
                        {relativeTime(repo.freshness.indexedAt, nowMs)}
                      </span>
                    ) : null}
                    {repo.freshness.fileCount != null ? (
                      <span className="text-muted-foreground/70">
                        {repo.freshness.fileCount} files
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    />
  );
}

interface SourceRecallRefreshProps {
  result: SourceRecallRefreshResult | null;
  status?: ToolStatus;
  defaultOpen?: boolean;
  className?: string;
}

export function SourceRecallRefresh({
  result,
  status = "done",
  defaultOpen = true,
  className,
}: SourceRecallRefreshProps) {
  if (status === "running" && !result) {
    return (
      <StatusAwareToolRenderer
        name="source_index_refresh"
        status={status}
        running
        runningLabel="refreshing the index"
        defaultOpen={defaultOpen}
        className={className}
      />
    );
  }

  const isError = !result || result.status === "error";
  const line = !result
    ? "Refresh failed."
    : result.status === "ok"
      ? `Re-indexed ${result.filesUpdated ?? 0} file${result.filesUpdated === 1 ? "" : "s"}${
          result.refreshMs != null ? ` in ${result.refreshMs}ms` : ""
        }.`
      : result.status === "rate_limited"
        ? `Refresh rate-limited: ${result.diagnostics[0]?.detail ?? "retry shortly"}.`
        : (result.diagnostics[0]?.detail ?? "Refresh unavailable.");

  return (
    <StatusAwareToolRenderer
      name="source_index_refresh"
      status={isError ? "error" : status}
      defaultOpen={defaultOpen}
      className={className}
      renderBody={() => (
        <span
          className={cn(
            "text-sm",
            result?.status === "rate_limited" ? "text-smui-yellow/90" : "text-muted-foreground",
          )}
        >
          {line}
        </span>
      )}
    />
  );
}
