import { ArrowUpRight } from "lucide-react";
import { ToolCall, WorkingIndicator } from "./message";
import { ToolSection } from "./tool-section";

/** One normalized search result, mirroring the web-search library's `Source`. */
export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  /** Provider-reported recency (e.g. "2 days ago"); null/absent when unknown. */
  published?: string | null;
}

interface WebSearchResultsProps {
  /** The query the model searched for (the tool's `query` argument). */
  query: string;
  /** Which backend served the results; shown in the meta line. */
  provider?: "brave" | "serper";
  /** Recency filter the model passed, if any; shown as "past <freshness>". */
  freshness?: "day" | "week" | "month" | "year";
  results?: readonly WebSearchResultItem[];
  /** A rendered error (e.g. missing credentials, all providers failed). */
  error?: string;
  status?: "running" | "done" | "error";
  /** Whether the results body starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  /**
   * Draw the results inside a bordered ToolSection box. Off by default: the single
   * result list sits flat under the already-collapsible tool row, so the box would be
   * redundant. This is the seam to box the list when wanted.
   */
  border?: boolean;
  className?: string;
}

/** Hostname + path, www-stripped, for the subdued link line under each title. */
function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname.replace(/^www\./u, "")}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Renders a `web_search` tool call: the ToolCall row (name + query) over a
 * `provider · count · recency` meta line and a list of normalized results, each a
 * title link with its source URL and snippet. Flat by default (the row already
 * collapses); pass `border` to wrap it in the shared ToolSection box. Falls back to a
 * working indicator while running and a red message on error.
 */
export function WebSearchResults({
  query,
  provider,
  freshness,
  results,
  error,
  status = "done",
  defaultOpen = true,
  border = false,
  className,
}: WebSearchResultsProps) {
  if (error) {
    return (
      <ToolCall
        name="web_search"
        args={query}
        status="error"
        defaultOpen={defaultOpen}
        className={className}
      >
        <span className="text-sm text-smui-red">{error}</span>
      </ToolCall>
    );
  }

  if (status === "running" && (!results || results.length === 0)) {
    return (
      <ToolCall
        name="web_search"
        args={query}
        status="running"
        defaultOpen={defaultOpen}
        className={className}
      >
        <WorkingIndicator label="searching" />
      </ToolCall>
    );
  }

  const items = results ?? [];
  const meta = [
    provider,
    `${items.length} result${items.length === 1 ? "" : "s"}`,
    freshness ? `past ${freshness}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const list =
    items.length === 0 ? (
      <span className="text-sm italic text-muted-foreground">No results.</span>
    ) : (
      <ol className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.url} className="flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-3">
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-smui-frost-3 hover:underline"
              >
                {item.title}
                <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </a>
              {item.published ? (
                <span className="shrink-0 text-label tracking-wider text-muted-foreground/70">
                  {item.published}
                </span>
              ) : null}
            </div>
            <span className="truncate text-xs text-smui-frost-3/80">{prettyUrl(item.url)}</span>
            <p className="text-sm text-muted-foreground">{item.snippet}</p>
          </li>
        ))}
      </ol>
    );

  return (
    <ToolCall
      name="web_search"
      args={query}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
    >
      {border ? (
        <ToolSection title={<span className="text-muted-foreground">{meta}</span>}>
          <div className="p-2.5">{list}</div>
        </ToolSection>
      ) : (
        <div className="flex flex-col gap-2.5">
          <span className="text-label tracking-wider text-muted-foreground/70">{meta}</span>
          {list}
        </div>
      )}
    </ToolCall>
  );
}
